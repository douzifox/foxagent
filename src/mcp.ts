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

const CLI_PATH = path.join(__dirname, "cli.ts");

const STATUS_CHUNK = 8000; // fox_status 单次最多带走的输出字符数
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
}

const tasks = new Map<string, FoxTask>();
let taskSeq = 0;

const TOOLS = [
  {
    name: "fox_submit",
    description:
      "派任务给 FoxAgent（轻量 coding agent）并立即返回 taskId，不等待完成。" +
      "它会在指定目录里自主读代码、改文件、跑命令。适合机械性执行任务（批量修改、按模板铺文件、跑构建验证）。" +
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
      },
      required: ["task", "cwd"],
    },
  },
  {
    name: "fox_status",
    description:
      "查询 FoxAgent 任务状态，返回自上次查询以来的增量输出。" +
      "state=waiting_for_input 时附带 question，需要用 fox_reply 回答任务才会继续；" +
      "state=done/failed 时附带结构化结果摘要和完整轨迹日志路径。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "fox_submit 返回的任务 id" },
      },
      required: ["taskId"],
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

function submitTask(args: any): { ok: true; taskId: string; logPath: string } | { ok: false; message: string } {
  const task = String(args?.task || "");
  const cwd = String(args?.cwd || "");
  if (!task || !cwd) return { ok: false, message: "缺少 task 或 cwd 参数" };
  if (!path.isAbsolute(cwd)) return { ok: false, message: `cwd 必须是绝对路径：${cwd}` };
  let isDir = false;
  try {
    isDir = fs.statSync(cwd).isDirectory();
  } catch {}
  if (!isDir) return { ok: false, message: `工作目录不存在或不是目录：${cwd}` };

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
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const t: FoxTask = {
    child,
    state: "running",
    pending: "",
    lineBuf: "",
    logPath,
    log: fs.createWriteStream(logPath),
  };
  tasks.set(taskId, t);

  child.stdout!.on("data", (d) => onStdoutChunk(t, d.toString("utf-8")));
  child.stderr!.on("data", (d) => appendOut(t, d.toString("utf-8")));
  child.on("error", (e) => {
    appendOut(t, `启动子进程失败：${e.message}\n`);
    t.state = "failed";
    t.exitCode = 1;
    t.log.end();
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
  });

  return { ok: true, taskId, logPath };
}

function statusTask(taskId: string): any {
  const t = tasks.get(taskId);
  if (!t) {
    return {
      error: `任务 ${taskId} 不存在（MCP 服务器可能重启过，任务表不持久化）`,
    };
  }
  const newOutput = t.pending.slice(0, STATUS_CHUNK);
  t.pending = t.pending.slice(newOutput.length);
  const out: any = { state: t.state, newOutput };
  if (t.pending.length > 0) out.hasMore = true; // 还有没取完的输出，马上再调一次
  if (t.state === "waiting_for_input" && t.question) out.question = t.question;
  if (t.state === "done" || t.state === "failed") {
    out.exitCode = t.exitCode;
    out.result = t.result ?? null;
    out.logPath = t.logPath;
  }
  return out;
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
        serverInfo: { name: "foxagent", version: "0.2.0" },
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
            note: "任务已提交。用 fox_status 轮询进度；state=waiting_for_input 时需要 fox_reply 回答。",
          });
          break;
        }
        case "fox_status": {
          const s = statusTask(String(args?.taskId || ""));
          replyText(id, s, !!s.error);
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
