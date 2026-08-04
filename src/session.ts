import * as fs from "fs";
import * as path from "path";
import type { ChatMessage } from "./agent";
import type { PendingJournal } from "./journal";
import { sessionsDir } from "./paths";

// 会话按项目目录隔离（见 paths.ts），在哪个项目里干活就只看到哪个项目的会话。
// CLI 和 VS Code 插件读写同一份 —— 终端开的工，可以到编辑器里接着干
export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  // 本任务（会话）累积的日志暂存，会话切换/退出时才写入 journal
  pending?: PendingJournal;
}

export function createSession(): Session {
  const now = new Date();
  return {
    // 时间戳 + 随机后缀：防止 CLI/插件同毫秒创建撞 id 互相覆盖
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    messages: [],
  };
}

export function saveSession(root: string, session: Session): void {
  if (session.messages.length === 0) return;
  if (!session.title) {
    const firstUser = session.messages.find((m) => m.role === "user");
    session.title = (firstUser?.content || "").slice(0, 40).replace(/\n/g, " ");
  }
  session.updatedAt = new Date().toISOString();
  const dir = sessionsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  // 原子写：先写临时文件再 rename，避免进程中途被杀留下截断的半个 JSON
  const file = path.join(dir, `${session.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

function readSessionFile(dir: string, f: string): Session | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Session;
  } catch {
    return undefined; // 跳过损坏文件，不连累其他会话
  }
}

// 按 updatedAt 降序——"最近工作过的"才是想续的那个，不是创建最晚的
function loadAllSessions(root: string): Session[] {
  try {
    const dir = sessionsDir(root);
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readSessionFile(dir, f))
      .filter((s): s is Session => !!s)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  } catch {
    return [];
  }
}

export function loadLatestSession(root: string): Session | undefined {
  return loadAllSessions(root)[0];
}

export function listSessions(root: string): { id: string; title: string; updatedAt: string }[] {
  return loadAllSessions(root).map((s) => ({
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
  }));
}

export function loadSession(root: string, id: string): Session | undefined {
  // id 同时用作文件名——只允许安全字符，挡住 ../ 路径穿越
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  return readSessionFile(sessionsDir(root), `${id}.json`);
}
