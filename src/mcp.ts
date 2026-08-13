#!/usr/bin/env bun
// FoxAgent MCP Server：把 -p 模式包装成异步任务，供 Claude Code 等客户端全局调用。
// 协议：stdio 上按行 JSON 的 JSON-RPC 2.0（MCP 规范），手写不引 SDK，极简。
//
// 任务模型（P0）：
//   fox_submit 提交任务立即返回 taskId → fox_status 轮询增量输出 → fox_reply 回答提问。
// 与子进程（cli.ts -p）之间走哨兵行协议：
//   @@ASK@@{"type":"confirm"|"ask","question":...}  子进程提问，任务转 waiting_for_input
//   @@RESULT@@{...}                                  结构化收尾摘要（成果与事故分离）
// 任务表只在内存里：MCP 服务器进程活着任务就在，进程没了如实报「任务不存在」。
// 完整轨迹落盘到 ~/.foxagent/projects/<路径>/runs/<taskId>.log（项目目录零污染）。
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { projectDataDir } from "./paths";
import { summarizeSessions } from "./session";
import { loadConfig } from "./config";

const CLI_PATH = path.join(__dirname, "cli.ts");

const STATUS_CHUNK = 8000; // verbose 模式单次最多带走的输出字符数（分页 + hasMore）
const DEFAULT_TAIL = 1500; // 默认模式 newOutput 只回尾部这么多字符（决策 22：流水账灌上下文是调用方限流大头）
const BUFFER_CAP = 200_000; // 未取走输出的内存上限，超出丢中间留两头（完整轨迹在日志文件）

interface FoxTask {
  child: ChildProcess;
  state: "running" | "waiting_for_input" | "done" | "failed";
  pending: string; // 调用方尚未通过 fox_status 取走的输出
  lineBuf: string; // stdout 的半行缓冲（哨兵必须按整行识别）
  question?: { type: string; question: string };
  result?: any; // @@RESULT@@ 摘要（cli 侧输出后才有）
  exitCode?: number;
  logPath: string;
  log: fs.WriteStream;
  waiters: (() => void)[]; // fox_wait 的挂起者，状态跳出 running 时全部唤醒
}

// 状态跳变（waiting_for_input / done / failed）时唤醒所有挂起的 fox_wait
function wake(t: FoxTask) {
  const ws = t.waiters;
  t.waiters = [];
  for (const w of ws) w();
}

const tasks = new Map<string, FoxTask>();
let taskSeq = 0;

const TOOLS = [
  {
    name: "fox_submit",
    description:
      "派任务给 FoxAgent（轻量 coding agent）并立即返回 taskId，不等待完成。" +
      "它会在指定目录里自主读代码、改文件、跑命令。适合机械性执行任务（批量修改、按模板铺文件、跑构建验证）。" +
      "任务描述要给足背景：明确的判定标准、「重点但不限于」的文件清单、「不要动 X」的边界，它会执行得更好。" +
      "提交后用 fox_status 轮询进度；它可能中途提问（危险命令确认、歧义澄清），用 fox_reply 回答。",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "任务描述（会作为用户消息发给 FoxAgent）" },
        cwd: { type: "string", description: "工作目录（FoxAgent 在哪个项目里干活），必须是绝对路径" },
        session: {
          type: "string",
          description:
            "显式会话 id（任务结束时 result.sessionId 里返回）。想接着某次会话继续就传它；多任务并行时别用 continueSession，会串线",
        },
        continueSession: { type: "boolean", description: "是否续上最近一次会话（默认 false，开新会话）" },
        maxTokens: {
          type: "number",
          description:
            "可选的成本护栏（默认不限，任务跑到自然完成）。显式设置后：累计消耗到 80% 提醒模型收敛，" +
            "耗尽则总结进展后中断；软上限——提醒后放行的最后一轮可能超支 ~30%，设小值时留余量。" +
            "返回的 tokenBudget 字段回显生效值（不限时无此字段）",
        },
        maxIters: {
          type: "number",
          description:
            "响应轮数上限（默认 500），只是防死循环兜底——控制任务规模请用 maxTokens。" +
            "按模型响应轮计：一轮内批量发起多个工具调用只算一轮",
        },
      },
      required: ["task", "cwd"],
    },
  },
  {
    name: "fox_status",
    description:
      "查询 FoxAgent 任务状态（长任务建议每 2~4 分钟查一次）。newOutput 默认只带增量输出的尾部约 1.5k" +
      "字符（省 token；被省略部分见 logPath），要全量传 verbose。" +
      "state=waiting_for_input 时附带 question（全量），需要用 fox_reply 回答任务才会继续；" +
      "state=done/failed 时附带结构化结果摘要 result（全量）。任何状态都带 logPath（完整轨迹日志），" +
      "怀疑任务假死时直接 tail 该文件：以 @@RESULT@@ 行结尾说明进程其实已经收尾。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "fox_submit 返回的任务 id" },
        verbose: { type: "boolean", description: "true = newOutput 取全量（按 8k 分页，hasMore 提示继续取）。默认 false" },
        tailChars: { type: "number", description: "自定义 newOutput 尾部字符数（默认 1500，范围 200~100000）" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "fox_wait",
    description:
      "挂起等待 FoxAgent 任务出结果（推荐用它代替反复 fox_status 轮询）。" +
      "任务完成/失败时返回结构化结果摘要（result），任务提问时立即返回 question（用 fox_reply 回答后可再 fox_wait）。" +
      "等满 timeoutSec 任务还没跑完则返回 state=running——这是正常的续租信号，再调一次继续等即可。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "fox_submit 返回的任务 id" },
        timeoutSec: {
          type: "number",
          description: "本次挂起最长等多少秒（默认 300，范围 5~570；需短于客户端的 MCP 工具超时）",
        },
        verbose: { type: "boolean", description: "true = newOutput 取全量。默认 false（只带尾部约 1.5k 字符，result/question 不受影响）" },
        tailChars: { type: "number", description: "自定义 newOutput 尾部字符数（默认 1500，范围 200~100000）" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "fox_sessions",
    description:
      "列出某个项目目录的 FoxAgent 历史会话（按最近更新降序）：sessionId、起止时间、响应轮数、" +
      "最近任务与最后一次回复的摘要。想接着之前的工作时先用它找到目标会话，再 fox_submit 传 session 续上——" +
      "之前的分析上下文都还在。",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "项目目录（会话按项目隔离存储），必须是绝对路径" },
        limit: { type: "number", description: "最多返回几条（默认 10）" },
      },
      required: ["cwd"],
    },
  },
  {
    name: "fox_reply",
    description:
      "回答 FoxAgent 的提问（危险命令确认回 y/n，开放问题直接回答内容），任务随即继续执行。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "任务 id" },
        answer: { type: "string", description: "回答内容。确认类问题用 y 表示同意，其他文本均视为拒绝" },
      },
      required: ["taskId", "answer"],
    },
  },
];

function send(msg: any) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: any, result: any) {
  send({ jsonrpc: "2.0", id, result });
}

function replyText(id: any, obj: any, isError = false) {
  reply(id, { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], isError });
}

function error(id: any, code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// 输出进内存缓冲（供 fox_status 增量取走）+ 落日志文件
function appendOut(t: FoxTask, s: string) {
  if (!s) return;
  t.log.write(s);
  t.pending += s;
  if (t.pending.length > BUFFER_CAP) {
    t.pending =
      t.pending.slice(0, BUFFER_CAP / 4) +
      "\n…（输出积压过多，中间已丢弃，完整轨迹见日志文件）\n" +
      t.pending.slice(-BUFFER_CAP / 4);
  }
}

// stdout 按整行扫描哨兵；普通行原样进缓冲
function onStdoutChunk(t: FoxTask, chunk: string) {
  t.lineBuf += chunk;
  let idx: number;
  while ((idx = t.lineBuf.indexOf("\n")) >= 0) {
    const line = t.lineBuf.slice(0, idx);
    t.lineBuf = t.lineBuf.slice(idx + 1);
    if (line.startsWith("@@ASK@@")) {
      t.log.write(line + "\n");
      try {
        t.question = JSON.parse(line.slice("@@ASK@@".length));
        t.state = "waiting_for_input";
        wake(t); // 挂起的 fox_wait 必须立即拿到 question，否则没人能 fox_reply，死锁
      } catch {
        appendOut(t, line + "\n"); // 解析不了就当普通输出，别吞
      }
    } else if (line.startsWith("@@RESULT@@")) {
      t.log.write(line + "\n");
      try {
        t.result = JSON.parse(line.slice("@@RESULT@@".length));
      } catch {
        appendOut(t, line + "\n");
      }
    } else {
      appendOut(t, line + "\n");
    }
  }
}

function submitTask(
  args: any
): { ok: true; taskId: string; logPath: string; tokenBudget?: number } | { ok: false; message: string } {
  const task = String(args?.task || "");
  const cwd = String(args?.cwd || "");
  if (!task || !cwd) return { ok: false, message: "缺少 task 或 cwd 参数" };
  if (!path.isAbsolute(cwd)) return { ok: false, message: `cwd 必须是绝对路径：${cwd}` };
  let isDir = false;
  try {
    isDir = fs.statSync(cwd).isDirectory();
  } catch {}
  if (!isDir) return { ok: false, message: `工作目录不存在或不是目录：${cwd}` };
  let maxIters: number | undefined;
  if (args?.maxIters !== undefined) {
    const v = Number(args.maxIters);
    if (!Number.isInteger(v) || v < 1 || v > 10_000) {
      return { ok: false, message: `maxIters 应为 1~10000 的整数：${args.maxIters}` };
    }
    maxIters = v;
  }
  let maxTokens: number | undefined;
  if (args?.maxTokens !== undefined) {
    const v = Number(args.maxTokens);
    if (!Number.isInteger(v) || v < 10_000 || v > 1_000_000_000) {
      return { ok: false, message: `maxTokens 应为 10000~1000000000 的整数：${args.maxTokens}` };
    }
    maxTokens = v;
  }
  // 本任务实际生效的预算，露给调用方核对（默认不限；Infinity 进不了 JSON，不带字段即表示不限）
  let tokenBudget: number | undefined = maxTokens;
  if (tokenBudget === undefined) {
    try {
      tokenBudget = loadConfig().maxTokens;
    } catch {}
  }
  if (tokenBudget === Infinity) tokenBudget = undefined;

  const taskId = `t${Date.now().toString(36)}-${++taskSeq}`;
  // 轨迹放 FoxAgent 自己的数据目录（项目目录零污染，也不用操心 gitignore）
  const runsDir = path.join(projectDataDir(cwd), "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const logPath = path.join(runsDir, `${taskId}.log`);

  const cliArgs = [CLI_PATH, "-p", task];
  if (args?.session) cliArgs.push("--session", String(args.session));
  else if (args?.continueSession) cliArgs.push("--continue");
  const child = spawn("bun", cliArgs, {
    cwd,
    // 预算/轮数走环境变量透传（config.ts 统一读，不另开参数通道）
    env: {
      ...process.env,
      ...(maxIters ? { FOXAGENT_MAX_ITERS: String(maxIters) } : {}),
      ...(maxTokens ? { FOXAGENT_MAX_TOKENS: String(maxTokens) } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const t: FoxTask = {
    child,
    state: "running",
    pending: "",
    lineBuf: "",
    logPath,
    log: fs.createWriteStream(logPath),
    waiters: [],
  };
  tasks.set(taskId, t);

  child.stdout!.on("data", (d) => onStdoutChunk(t, d.toString("utf-8")));
  child.stderr!.on("data", (d) => appendOut(t, d.toString("utf-8")));
  child.on("error", (e) => {
    appendOut(t, `启动子进程失败：${e.message}\n`);
    t.state = "failed";
    t.exitCode = 1;
    t.log.end();
    wake(t);
  });
  child.on("close", (code) => {
    if (t.lineBuf) {
      appendOut(t, t.lineBuf + "\n"); // 冲刷最后的半行
      t.lineBuf = "";
    }
    t.exitCode = code ?? 1;
    // 退出码语义（见 cli.ts）：0 = 有成果（含收尾翻车的部分成功），非 0 = 颗粒无收
    t.state = t.exitCode === 0 ? "done" : "failed";
    t.log.end();
    wake(t);
  });

  return { ok: true, taskId, logPath, tokenBudget };
}

interface OutputOpts {
  verbose?: boolean; // 全量模式：按 STATUS_CHUNK 分页 + hasMore（旧行为）
  tailChars?: number; // 尾部字符数（默认 DEFAULT_TAIL）
}

function statusTask(taskId: string, opts?: OutputOpts): any {
  const t = tasks.get(taskId);
  if (!t) {
    return {
      error: `任务 ${taskId} 不存在（MCP 服务器可能重启过，任务表不持久化）`,
    };
  }
  // newOutput 默认只回尾部（决策 22）：几 KB 流水账灌进调用方上下文、随满窗口每轮重复计费。
  // 终态 result 与 question 不受影响——价值密度高，保持全量
  let newOutput: string;
  if (opts?.verbose) {
    newOutput = t.pending.slice(0, STATUS_CHUNK);
    t.pending = t.pending.slice(newOutput.length);
  } else {
    const rawTail = Number(opts?.tailChars);
    const tail = Number.isFinite(rawTail) ? Math.min(Math.max(rawTail, 200), 100_000) : DEFAULT_TAIL;
    const full = t.pending;
    t.pending = ""; // 尾部模式一次性清空缓冲，被省略的部分只活在日志文件里
    newOutput =
      full.length > tail
        ? `[前 ${full.length - tail} 字符已省略，完整轨迹见 logPath]\n` + full.slice(-tail)
        : full;
  }
  // logPath 任何状态都给：运行中调用方可以直接 tail 判断是否假死（增量长时间为空 ≠ 挂了）
  const out: any = { state: t.state, newOutput, logPath: t.logPath };
  if (t.pending.length > 0) out.hasMore = true; // verbose 模式还有没取完的输出，马上再调一次
  if (t.state === "waiting_for_input" && t.question) out.question = t.question;
  if (t.state === "done" || t.state === "failed") {
    out.exitCode = t.exitCode;
    out.result = t.result ?? null;
    // 中断（循环上限/模型调用失败/被打断）→ 直接教怎么续，别让调用方误判为「跑完了」或「全失败」
    if (typeof t.result?.outcome === "string" && t.result.outcome.startsWith("中断")) {
      out.note =
        "任务中途被中断（原因见 result.outcome）。要接着干：fox_submit 传 session=result.sessionId 续会话，" +
        "任务描述里明确要求「基于已有分析收敛产出，不要重新大面积浏览」；因护栏中断的话，调大或去掉 maxTokens 再续。";
    }
  }
  return out;
}

// 挂起直到任务跳出 running（完成/失败/提问），或等满 timeoutSec。
// 返回格式与 fox_status 完全一致（含增量输出与终态 result）；超时时 state 仍是 running，
// 调用方再调一次续等即可（续租模式：server 端超时要短于 MCP 客户端的工具超时）
async function waitTask(taskId: string, timeoutSec: number, opts?: OutputOpts): Promise<any> {
  const t = tasks.get(taskId);
  if (!t) {
    return { error: `任务 ${taskId} 不存在（MCP 服务器可能重启过，任务表不持久化）` };
  }
  const deadline = Date.now() + timeoutSec * 1000;
  while (t.state === "running" && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      // 定时醒一次兜底（防状态跳变时 wake 因异常路径漏发），到点或被 wake 都继续判断循环条件
      const done = () => {
        clearTimeout(timer);
        const i = t.waiters.indexOf(done);
        if (i >= 0) t.waiters.splice(i, 1); // 超时醒来时把自己摘掉，别在数组里越积越多
        resolve();
      };
      const timer = setTimeout(done, Math.min(deadline - Date.now(), 10_000));
      t.waiters.push(done);
    });
  }
  const s = statusTask(taskId, opts);
  if (s.state === "running") {
    s.note = `等待 ${timeoutSec} 秒后任务仍在运行（正常，长任务需要时间）。再调一次 fox_wait 续等即可。`;
  }
  return s;
}

function replyTask(taskId: string, answer: string): { ok: boolean; message: string } {
  const t = tasks.get(taskId);
  if (!t) return { ok: false, message: `任务 ${taskId} 不存在` };
  if (t.state === "done" || t.state === "failed") {
    return { ok: false, message: "任务已结束，无法回复" };
  }
  t.child.stdin!.write(answer + "\n");
  t.state = "running";
  t.question = undefined;
  return { ok: true, message: "已送达，任务继续执行" };
}

async function handleMessage(msg: any) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "foxagent", version: "0.3.0" },
        // server-level 使用要领：让任何项目目录、任何新 session 首次连上就自带完整用法
        // （per-project 记忆传播不到别的目录，这里是跨项目唯一可靠渠道）
        instructions:
          "FoxAgent 使用要领：\n" +
          "【写工单】任务描述给足背景：明确判定标准、「重点但不限于」的文件清单、「不要动 X」的边界。" +
          "要在工作区外产出文件（报告等）时，在工单里提醒它用 run_command 重定向写（write_file 只能写工作区内）。\n" +
          "【等待】两种模式按场景选：赶工用 fox_wait 挂起（超时返回 running 是续租信号，再调即可）；" +
          "需要边等边处理别的事时改零占用模式——后台定时 grep 日志文件（fox_submit 返回的 logPath），" +
          "出现 @@RESULT@@ 行即任务收尾，不占用你的回合。\n" +
          "【验收】优先读它的产出文件和 result 摘要、需要细节时 grep logPath——" +
          "别依赖 newOutput 全量（默认只回尾部，为省你的上下文）。\n" +
          "【续会话】跨 session 接续工作：先 fox_sessions 按 cwd 列历史会话（含最近任务与最后回复摘要），" +
          "再 fox_submit 传 session=<id> 续上，旧分析上下文都在。续跑中断任务时在工单里要求" +
          "「基于已有分析收敛产出，不要重新大面积浏览」。多任务并行必须用显式 session id，别用 continueSession（会串线）。",
      });
      break;
    case "notifications/initialized":
      break; // 通知，无需回复
    case "tools/list":
      reply(id, { tools: TOOLS });
      break;
    case "tools/call": {
      const { name, arguments: args } = params ?? {};
      switch (name) {
        case "fox_submit": {
          const r = submitTask(args);
          if (!r.ok) {
            replyText(id, { error: r.message }, true);
            break;
          }
          replyText(id, {
            taskId: r.taskId,
            logPath: r.logPath,
            ...(r.tokenBudget !== undefined ? { tokenBudget: r.tokenBudget } : {}),
            note:
              "任务已提交。赶工用 fox_wait 挂起等待（超时返回 running 就再调续等）；" +
              "想边等边干别的就零占用等法：后台定时 grep 上面的 logPath，出现 @@RESULT@@ 行即收尾。" +
              "state=waiting_for_input 时需要 fox_reply 回答。",
          });
          break;
        }
        case "fox_status": {
          const s = statusTask(String(args?.taskId || ""), {
            verbose: args?.verbose === true,
            tailChars: args?.tailChars,
          });
          replyText(id, s, !!s.error);
          break;
        }
        case "fox_wait": {
          // clamp 而非报错：等待时长是软约束，上限留在 MCP 客户端默认工具超时（600s）之内
          const raw = Number(args?.timeoutSec);
          const timeoutSec = Number.isFinite(raw) ? Math.min(Math.max(raw, 5), 570) : 300;
          const s = await waitTask(String(args?.taskId || ""), timeoutSec, {
            verbose: args?.verbose === true,
            tailChars: args?.tailChars,
          });
          replyText(id, s, !!s.error);
          break;
        }
        case "fox_sessions": {
          const cwd = String(args?.cwd || "");
          if (!path.isAbsolute(cwd)) {
            replyText(id, { error: `cwd 必须是绝对路径：${cwd}` }, true);
            break;
          }
          const rawLimit = Number(args?.limit);
          const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
          const sessions = summarizeSessions(cwd).slice(0, limit);
          replyText(id, {
            sessions,
            ...(sessions.length === 0
              ? { note: "该目录还没有任何 FoxAgent 会话（或路径拼写与当时干活的 cwd 不一致）" }
              : {}),
          });
          break;
        }
        case "fox_reply": {
          const r = replyTask(String(args?.taskId || ""), String(args?.answer ?? ""));
          replyText(id, r, !r.ok);
          break;
        }
        default:
          error(id, -32601, `未知工具：${name}`);
      }
      break;
    }
    default:
      if (id !== undefined) {
        error(id, -32601, `不支持的方法：${method}`);
      }
  }
}

// MCP stdio 传输层：每行一条 JSON（不是 LSP 的 Content-Length 分帧）
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const body = line.trim();
  if (!body) return;
  try {
    handleMessage(JSON.parse(body));
  } catch {}
});

rl.on("close", () => process.exit(0));
