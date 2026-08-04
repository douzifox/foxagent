import * as fs from "fs";
import * as path from "path";
import { projectDataDir } from "./paths";

// 工作日志：每轮任务结束后由代码自动追加（不靠模型自觉），供以后追溯。
// 追求摘要密度：动作聚合去重，整条日志控制在几行内，不做流水账。
// 位置：~/.foxagent/projects/<项目路径>/journal.md
export interface Action {
  kind: "edit" | "write" | "run";
  target: string;
  failed: boolean;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// "修改 a.ts(×3)、b.ts；新建 c.md" —— 同一文件合并计数，失败的单独标注
function summarizeFiles(actions: Action[]): string {
  const parts: string[] = [];
  for (const kind of ["edit", "write"] as const) {
    const counts = new Map<string, number>();
    for (const a of actions) {
      if (a.kind !== kind) continue;
      const key = a.target + (a.failed ? "（失败）" : "");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (counts.size === 0) continue;
    const list = [...counts.entries()]
      .map(([f, n]) => (n > 1 ? `${f}(×${n})` : f))
      .join("、");
    parts.push(`${kind === "edit" ? "修改" : "新建"} ${list}`);
  }
  return parts.join("；");
}

function summarizeCommands(actions: Action[]): string {
  const runs = actions.filter((a) => a.kind === "run");
  if (runs.length === 0) return "";
  const shown = runs
    .slice(0, 3)
    .map((a) => a.target.slice(0, 50) + (a.failed ? "（失败）" : ""))
    .join("；");
  return runs.length > 3 ? `${shown} 等 ${runs.length} 条` : shown;
}

// 任务的暂存记录：跨多轮对话累积（存在会话对象里随会话持久化），
// 会话切换/退出时才合并写入 journal——记录粒度是任务，不是轮次
export interface PendingJournal {
  task: string;
  actions: Action[];
  pitfalls: string[];
  outcome: string;
}

export function mergePending(
  prev: PendingJournal | undefined,
  task: string,
  round: { actions: Action[]; pitfalls: string[]; outcome: string }
): PendingJournal {
  return {
    task: prev?.task || task, // 任务名以第一轮的用户消息为准
    actions: [...(prev?.actions || []), ...round.actions],
    pitfalls: [...(prev?.pitfalls || []), ...round.pitfalls],
    outcome: round.outcome || prev?.outcome || "",
  };
}

export function flushJournal(root: string, pending?: PendingJournal): void {
  if (!pending) return;
  appendJournal(root, pending.task, pending.actions, pending.pitfalls, pending.outcome);
}

function appendJournal(
  root: string,
  task: string,
  actions: Action[],
  pitfalls: string[],
  outcome: string
): void {
  // 动过手、或者踩过坑的任务才记；纯问答不记
  if (actions.length === 0 && pitfalls.length === 0) return;
  try {
    const dir = projectDataDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const clean = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
    const files = summarizeFiles(actions);
    const cmds = summarizeCommands(actions);
    // 坑是日志的核心价值：去重、限量，给后面的人看
    const uniqPitfalls = [...new Set(pitfalls)].slice(0, 4);
    const entry =
      `## ${stamp()}\n` +
      `**任务**：${clean(task, 150)}\n` +
      (files ? `**改动**：${files}\n` : "") +
      (cmds ? `**命令**：${cmds}\n` : "") +
      (uniqPitfalls.length
        ? `**坑**：${uniqPitfalls.map((p) => clean(p, 90)).join("；")}\n`
        : "") +
      `**结果**：${clean(outcome, 200)}\n\n`;
    fs.appendFileSync(path.join(dir, "journal.md"), entry, "utf-8");
  } catch {}
}
