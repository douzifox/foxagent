import * as os from "os";
import * as path from "path";

// 所有 FoxAgent 数据集中在 ~/.foxagent/ 下，项目数据按项目路径隔离：
//   ~/.foxagent/FOXAGENT.md                  用户的全局指示（跨项目，单文件，全文注入）
//   ~/.foxagent/projects/<项目路径>/memory/   项目记忆（索引 + 每条一个文件）
//   ~/.foxagent/projects/<项目路径>/sessions/ 会话
//   ~/.foxagent/projects/<项目路径>/journal.md 工作档案（纯追溯，不注入）
// 项目目录本身不放任何东西
export const FOXAGENT_HOME = path.join(os.homedir(), ".foxagent");

export const GLOBAL_FILE = path.join(FOXAGENT_HOME, "FOXAGENT.md");

export function projectDataDir(root: string): string {
  const key = root.replace(/[\/\\:]/g, "-");
  return path.join(FOXAGENT_HOME, "projects", key);
}

export function projectMemoryDir(root: string): string {
  return path.join(projectDataDir(root), "memory");
}

export function sessionsDir(root: string): string {
  return path.join(projectDataDir(root), "sessions");
}
