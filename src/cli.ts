#!/usr/bin/env node
// FoxAgent 的终端形态：bun src/cli.ts（或编译成单文件后直接跑）
// 与 VS Code 插件共用同一套 agent 核心和会话存储
import * as readline from "readline/promises";
import { emitKeypressEvents } from "readline";
import { stdin, stdout } from "process";
import { runAgent, ChatMessage } from "./agent";
import { loadConfig } from "./config";
import { flushJournal, mergePending } from "./journal";
import { buildSystemPrompt } from "./prompt";
import {
  Session,
  createSession,
  saveSession,
  loadLatestSession,
  listSessions,
  loadSession,
} from "./session";

// 剥掉模型输出中的 ANSI 转义序列，防终端注入（我们自己的着色另走 dim/cyan 等）
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const italic = (s: string) => `\x1b[3m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function colorDiff(diffText: string): string {
  return diffText
    .split("\n")
    .map((l) => {
      if (l.startsWith("+")) return green(l);
      if (l.startsWith("-")) return red(l);
      if (l.startsWith("@@")) return cyan(l);
      return dim(l);
    })
    .join("\n");
}

// -p 单任务模式：给程序（比如 Claude Code）调用的非交互入口。
// 无确认交互——危险命令一律拒绝并如实汇报，让调用方自己处理；干完即退。
async function runOnce(task: string, continueSession: boolean) {
  let config;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  const root = process.cwd();
  let session = continueSession ? loadLatestSession(root) : undefined;
  if (!session) session = createSession();
  if (session.messages.length === 0) {
    session.messages.push({ role: "system", content: buildSystemPrompt(root) });
  }
  session.messages.push({ role: "user", content: task });

  const round = await runAgent({
    ...config,
    root,
    messages: session.messages,
    onEvent: (e) => {
      switch (e.type) {
        case "delta":
          if (e.kind === "text") process.stdout.write(e.text);
          break;
        case "delta_end":
          process.stdout.write("\n");
          break;
        case "text":
          console.log(e.text);
          break;
        case "tool":
          console.log(`[tool] ${e.name} ${JSON.stringify(e.args)}`);
          break;
        case "tool_result": {
          const preview = e.output.length > 400 ? e.output.slice(0, 400) + "…" : e.output;
          console.log(preview.split("\n").map((l) => "  " + l).join("\n"));
          break;
        }
        case "status":
          console.log(`[status] ${e.text}`);
          break;
        case "error":
          console.error(`[error] ${e.text}`);
          process.exitCode = 1; // 调用方看退出码即可知道任务是否翻车
          break;
      }
    },
    confirmCommand: async (cmd) => {
      console.log(`[blocked] 非交互模式，危险命令已拒绝：${cmd}`);
      return false;
    },
    showEdit: (file, diffText) => {
      console.log(`[edit] ${file}\n${diffText}`);
    },
  });

  session.pending = mergePending(session.pending, task, round);
  if (round.committed) {
    flushJournal(root, session.pending);
    session.pending = undefined;
  }
  saveSession(root, session);
  if (round.outcome.startsWith("中断")) process.exitCode = 1;
}

async function main() {
  const argvAll = process.argv.slice(2);
  const pIdx = argvAll.indexOf("-p");
  if (pIdx >= 0 && argvAll[pIdx + 1]) {
    await runOnce(argvAll[pIdx + 1], argvAll.includes("--continue"));
    return;
  }

  const root = process.cwd();
  let config;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(red(String(e.message || e)));
    process.exit(1);
  }
  const { host, model } = config;

  let session: Session | undefined;
  if (!process.argv.includes("--new")) session = loadLatestSession(root);
  const resumed = !!session;
  if (!session) session = createSession();

  // 恢复会话时把历史回放到终端，thinking 也一并保留显示
  const replay = (messages: ChatMessage[]) => {
    for (const m of messages) {
      if (m.role === "user") console.log(cyan("\n🦊 > ") + m.content);
      else if (m.role === "assistant") {
        if (m.thinking) console.log(dim(italic(`\n💭 ${m.thinking}`)));
        for (const c of m.tool_calls || []) {
          console.log(cyan(`\n🔧 ${c.function?.name} `) + dim(JSON.stringify(c.function?.arguments)));
        }
        if (m.content) console.log(`\n${m.content}`);
      } else if (m.role === "tool") {
        const preview = m.content.length > 200 ? m.content.slice(0, 200) + "…" : m.content;
        console.log(dim(preview.split("\n").map((l) => "   " + l).join("\n")));
      }
    }
  };

  console.log(`\n🦊 ${yellow("FoxAgent")} ${dim(`· ${model} · ${host}`)}`);
  console.log(dim(`   工作目录：${root}`));
  console.log(
    resumed
      ? dim(`   继续上次会话「${session.title}」（${session.messages.length} 条消息）；开新会话用 /new`)
      : dim("   新会话。命令：/new 新会话 /sessions 列出会话 /resume <id> 恢复 /exit 退出")
  );
  if (resumed) replay(session.messages);

  const rl = readline.createInterface({ input: stdin, output: stdout });

  // Esc 打断当前轮（会话保留）；Ctrl+C 退出（保存后再见）——和 CC 一致的手感
  let currentAbort: AbortController | null = null;
  emitKeypressEvents(stdin);
  stdin.on("keypress", (_str, key) => {
    if (!key) return;
    if (key.name === "escape" && currentAbort) {
      currentAbort.abort();
      console.log(yellow("\n⏹ 已打断，会话保留"));
    }
    // 干活期间按 ↑：readline 的输入历史会把最近那条排队消息召回到输入行，
    // 这里同步把它撤出队列——改完回车就是重新排队，不会重复发送
    if (key.name === "up" && currentAbort && queued.length > 0) {
      queued.pop();
    }
  });
  rl.on("SIGINT", () => {
    flushJournal(root, session!.pending);
    session!.pending = undefined; // 落盘后清空，否则下次启动会重复写 journal
    saveSession(root, session!);
    console.log(dim("\n再见 🦊"));
    process.exit(0);
  });
  // agent 干活期间的输入进入队列，本轮结束后预填到输入行——回车发送、可修改、退格撤回
  const queued: string[] = [];

  // stdin 关闭（管道输入耗尽、Ctrl-D）时返回 null，当作退出处理
  const question = async (prompt: string): Promise<string | null> => {
    try {
      return await rl.question(prompt);
    } catch {
      return null;
    }
  };

  const ask = async (q: string): Promise<boolean> => {
    // Esc 打断时 currentAbort 已 abort，悬空的 question 会被 catch 返回 null
    // 此时当作用户拒绝（而非 stdin 关闭），不要让主循环误退出
    if (currentAbort?.signal.aborted) return false;
    const a = (await question(q + dim("（y 同意，其他拒绝）> ")))?.trim().toLowerCase();
    return a === "y" || a === "yes";
  };

  while (true) {
    let text: string;
    if (queued.length > 0) {
      // 队列消息本轮结束后自动发送（干活期间随时可 ↑ 取回修改）
      text = queued.shift()!;
      console.log(cyan("\n🦊 > ") + text + dim("（来自队列）"));
    } else {
      const raw = await question(cyan("\n🦊 > "));
      if (raw === null) break;
      text = raw.trim();
    }
    if (!text) continue;

    if (text === "/exit" || text === "/quit") break;
    if (text === "/new") {
      // 会话切换 = 任务收尾：把累积的动作与坑写进 journal
      flushJournal(root, session.pending);
      session.pending = undefined;
      saveSession(root, session);
      session = createSession();
      console.log(dim("已开新会话"));
      continue;
    }
    if (text === "/sessions") {
      const list = listSessions(root);
      if (list.length === 0) console.log(dim("还没有历史会话"));
      for (const s of list.slice(0, 15)) {
        console.log(`  ${s.id}  ${dim(s.updatedAt.slice(0, 16))}  ${s.title}`);
      }
      continue;
    }
    if (text.startsWith("/resume ")) {
      const target = loadSession(root, text.slice(8).trim());
      if (!target) {
        console.log(red("没找到这个会话"));
        continue;
      }
      flushJournal(root, session.pending);
      session.pending = undefined;
      saveSession(root, session);
      session = target;
      console.log(dim(`已恢复会话「${session.title}」（${session.messages.length} 条消息）`));
      replay(session.messages);
      continue;
    }

    if (session.messages.length === 0) {
      session.messages.push({ role: "system", content: buildSystemPrompt(root) });
    }
    session.messages.push({ role: "user", content: text });

    let deltaKind: string | null = null; // 流式渲染状态：当前正在吐哪种内容
    currentAbort = new AbortController();
    const onLine = (l: string) => {
      const t = l.trim();
      if (t) {
        queued.push(t);
        console.log(dim("（已排队，本轮结束后自动发送；↑ 取回修改；Esc 打断）"));
      }
    };
    rl.on("line", onLine);
    const round = await runAgent({
      ...config,
      root,
      signal: currentAbort.signal,
      messages: session.messages,
      onEvent: (e) => {
        switch (e.type) {
          case "delta":
            if (deltaKind !== e.kind) {
              process.stdout.write(e.kind === "thinking" ? dim("\n💭 ") : "\n");
              deltaKind = e.kind;
            }
            process.stdout.write(
              e.kind === "thinking" ? dim(italic(stripAnsi(e.text))) : stripAnsi(e.text)
            );
            break;
          case "delta_end":
            if (deltaKind) process.stdout.write("\n");
            deltaKind = null;
            break;
          case "thinking":
            console.log(dim(italic(`\n💭 ${e.text}`)));
            break;
          case "text":
            console.log(`\n${e.text}`);
            break;
          case "tool":
            console.log(cyan(`\n🔧 ${e.name} `) + dim(JSON.stringify(e.args)));
            break;
          case "tool_result": {
            const preview = e.output.length > 500 ? e.output.slice(0, 500) + "…" : e.output;
            console.log(dim(preview.split("\n").map((l) => "   " + l).join("\n")));
            break;
          }
          case "status":
            console.log(yellow(`\n⏳ ${e.text}`));
            break;
          case "error":
            console.log(red(`\n⚠️ ${e.text}`));
            break;
        }
      },
      confirmCommand: (cmd) => ask(`\n${yellow("危险命令，要执行吗：")}${cmd}\n`),
      showEdit: (file, diffText) => {
        console.log(`\n${yellow(`✏️ ${file}`)}\n${colorDiff(diffText)}\n${dim("✅ 已应用")}`);
      },
    });

    currentAbort = null;
    rl.off("line", onLine);
    session.pending = mergePending(session.pending, text, round);
    // 成功 commit = 任务完成的确定信号，当场落盘这条任务记录
    if (round.committed) {
      flushJournal(root, session.pending);
      session.pending = undefined;
    }
    saveSession(root, session);
  }

  // 退出 = 任务告一段落，落盘
  flushJournal(root, session.pending);
  session.pending = undefined;
  saveSession(root, session);
  rl.close();
  console.log(dim("\n再见 🦊"));
}

main();
