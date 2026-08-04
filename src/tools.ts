import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { exec } from "child_process";
import { structuredPatch } from "diff";
import { FOXAGENT_HOME, projectDataDir, projectMemoryDir } from "./paths";

const MAX_OUTPUT = 8000;

// 工具层与界面解耦：VS Code 端弹面板/按钮，CLI 端打印/问 y/n，工具代码不关心是谁在答。
// 默认自动放行：文件修改直接应用（diff 通过 showEdit 展示），只有危险命令才走 confirmCommand
export interface ToolIO {
  confirmCommand: (cmd: string) => Promise<boolean>;
  showEdit: (file: string, diffText: string) => void;
  // ask 工具的通道：交互模式问真人，-p 模式走哨兵协议问调用方。
  // 返回 null = 没人接电话（stdin 已关 / 用户取消），工具层会如实告诉模型
  askUser?: (question: string) => Promise<string | null>;
}

// 只有匹配到这些的命令才需要用户点头，其余自动执行
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\b(del|rd|erase)\b/i,
  /\bdd\b/,
  /\bmkfs/,
  /\bformat\b/i,
  /git\s+push/,
  /git\s+reset\s+--hard/,
  /git\s+clean/,
  /git\s+checkout\s+(--\s+|\S+\s+)?\./, // git checkout . / -- . / HEAD . 都丢弃改动
  /\bsudo\b/,
  /\b(shutdown|reboot|halt)\b/,
  /\bkill(all)?\b/,
  /ch(mod|own)\s+(-\w*R|--recursive)/,
  /(curl|wget)[^|;&]*\|\s*(ba|z)?sh/,
  /Remove-Item/i,
];

export function isDangerous(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(cmd));
}

function truncate(s: string, limit = MAX_OUTPUT): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n…（输出过长，已截断，共 ${s.length} 字符）`;
}

// 校验绝对路径落在允许的根目录之内，否则拒绝
function ensureWithin(abs: string, roots: string[], original: string): string {
  for (const r of roots) {
    if (abs === r || abs.startsWith(r + path.sep)) return abs;
  }
  throw new Error(`路径 ${original} 超出了允许范围，已拒绝`);
}

// 把模型给的路径限制在工作区内（记忆所在的 ~/.foxagent/ 除外），防止越界读写。
// 模型常把项目记忆偷懒写成相对路径 memory/xxx——只要工作区里并没有这个目录/文件，
// 就视为项目记忆的简写，自动重定向到真正的记忆目录
function resolveSafe(root: string, p: string): string {
  // 重定向也必须过白名单：否则 memory/../../.. 能借重定向逃出 ~/.foxagent
  if (!path.isAbsolute(p)) {
    let redirected: string | undefined;
    if (p === "MEMORY.md" && !fsSync.existsSync(path.join(root, "MEMORY.md"))) {
      redirected = path.join(projectMemoryDir(root), "MEMORY.md");
    } else if (p === "journal.md" && !fsSync.existsSync(path.join(root, "journal.md"))) {
      redirected = path.join(projectDataDir(root), "journal.md");
    } else {
      const parts = p.split(/[\\/]/);
      if (parts[0] === "memory" && !fsSync.existsSync(path.join(root, "memory"))) {
        redirected = path.join(projectMemoryDir(root), ...parts.slice(1));
      }
    }
    if (redirected !== undefined) {
      return ensureWithin(path.resolve(redirected), [FOXAGENT_HOME], p);
    }
  }
  const abs = path.resolve(root, p);
  return ensureWithin(abs, [root, FOXAGENT_HOME], p);
}

function makeDiff(file: string, oldText: string, newText: string): string {
  const patch = structuredPatch(file, file, oldText, newText, "", "", { context: 3 });
  const lines: string[] = [];
  for (const h of patch.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    lines.push(...h.lines);
  }
  return lines.join("\n");
}

// 发给 Ollama 的工具定义 —— 描述写给模型看，是提示词的一部分
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "读取文件内容，返回带行号的文本。大文件请用 offset/limit 分段读，不要一次读入几千行。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径，相对于工作区根目录" },
          offset: { type: "number", description: "起始行号（从 1 开始），可选" },
          limit: { type: "number", description: "读取的行数，可选，默认最多 400 行" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "对已读过的文件做精确修改：把 old_string 替换为 new_string。old_string 必须与文件内容逐字符一致（含缩进），且在文件中唯一出现；不满足会报错，此时请重新 read_file 后再试。修改直接生效，diff 会展示给用户。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径，相对于工作区根目录" },
          old_string: { type: "string", description: "要被替换的原文片段，必须唯一" },
          new_string: { type: "string", description: "替换后的内容" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "创建新文件并写入内容（父目录会自动创建）。禁止用它整体覆盖已有文件——修改已有文件必须用 edit_file。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径，相对于工作区根目录" },
          content: { type: "string", description: "文件完整内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "列出目录内容，目录名以 / 结尾。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目录路径，相对于工作区根目录，默认为根目录" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "在项目中用正则搜索代码（基于 ripgrep），返回 文件:行号:内容。找函数、类、关键词的定义和引用都用它，别靠猜路径。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "搜索的正则表达式" },
          path: { type: "string", description: "限定搜索的子目录或文件，可选" },
          glob: {
            type: "string",
            description: "按文件名模式过滤，如 *.ts、src/**/*.vue，可选",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask",
      description:
        "向指挥者（用户或调用方）提问并等待回答。只在拿不准的决策、任务描述有歧义或矛盾时使用；" +
        "能自己查清楚的不要问——读代码、跑命令验证优先。问题要带上下文和你倾向的选项，别把提问变成甩锅。",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "要问的问题，附上必要上下文和你的倾向，如「棋盘索引是 g[y][x] 还是 g[x][y]？我看 render 里像前者」",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "在工作区根目录执行一条 shell 命令（跑测试、编译、git status 等）。普通命令直接执行；删除、git push 等危险命令会先请求用户确认。输出包含 stdout 和 stderr。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令" },
        },
        required: ["command"],
      },
    },
  },
];

async function readFileTool(root: string, args: any): Promise<string> {
  const abs = resolveSafe(root, args.path);
  const content = await fs.readFile(abs, "utf-8");
  const lines = content.split("\n");
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.min(Number(args.limit) || 400, 2000);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice
    .map((l, i) => `${String(offset + i).padStart(5)}→${l}`)
    .join("\n");
  const tail =
    offset - 1 + limit < lines.length
      ? `\n…（文件共 ${lines.length} 行，可用 offset 继续读）`
      : "";
  return truncate(numbered + tail, 30000);
}

async function editFileTool(root: string, args: any, io: ToolIO): Promise<string> {
  const abs = resolveSafe(root, args.path);
  const content = await fs.readFile(abs, "utf-8");
  const { old_string, new_string } = args;
  if (!old_string) throw new Error("old_string 不能为空");
  // 缺 new_string 时 replace 会写入字面量 "undefined"，静默损坏文件
  if (typeof new_string !== "string") throw new Error("new_string 必须是字符串（删除内容请传空字符串）");
  // 经典坑：模型把 read_file 显示的行号前缀（如「    1→」）当成文件内容抄进来
  if (/^\s*\d+→/m.test(old_string) && !/^\s*\d+→/m.test(content)) {
    throw new Error(
      "old_string 里包含了 read_file 显示用的行号前缀（数字→）。那不是文件内容！请去掉行号和箭头，只用文件的原文重试。"
    );
  }
  const count = content.split(old_string).length - 1;
  if (count === 0) {
    throw new Error("old_string 在文件中没有找到。请重新 read_file 获取最新内容，确保逐字符一致（包括缩进）。");
  }
  if (count > 1) {
    throw new Error(`old_string 在文件中出现了 ${count} 次，无法确定改哪一处。请扩大 old_string 的范围使其唯一。`);
  }
  const newContent = content.replace(old_string, new_string);
  io.showEdit(args.path, makeDiff(args.path, content, newContent));
  await fs.writeFile(abs, newContent, "utf-8");
  return `已修改 ${args.path}`;
}

async function writeFileTool(root: string, args: any, io: ToolIO): Promise<string> {
  const abs = resolveSafe(root, args.path);
  let exists = false;
  try {
    await fs.stat(abs);
    exists = true;
  } catch {}
  if (exists) {
    throw new Error(
      `${args.path} 已存在，禁止整体覆盖。正确做法：先 read_file 查看当前内容，再用 edit_file 修改或追加。请立即这样做，不要跳过。`
    );
  }
  io.showEdit(args.path, makeDiff(args.path, "", args.content));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, args.content, "utf-8");
  return `已创建 ${args.path}`;
}

async function listDirTool(root: string, args: any): Promise<string> {
  const abs = resolveSafe(root, args.path || ".");
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const listed = entries
    .filter((e) => e.name !== "node_modules" && e.name !== ".git" && e.name !== ".foxagent")
    .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
    .sort();
  return truncate(listed.join("\n") || "（空目录）");
}

function runExec(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let out = "";
        if (stdout) out += stdout;
        if (stderr) out += (out ? "\n--- stderr ---\n" : "") + stderr;
        if (err && (err as any).code !== undefined && (err as any).code !== 0) {
          out += `\n（退出码 ${(err as any).code}）`;
        } else if (err && !out) {
          out = String(err.message);
        }
        resolve(out || "（无输出）");
      }
    );
  });
}

// 单引号包裹 + 转义，防 shell 注入（三个片段都必须过，target 曾漏）
const shq = (s: string): string => `'${String(s).replace(/'/g, "'\\''")}'`;

async function searchTool(root: string, args: any): Promise<string> {
  const target = args.path ? resolveSafe(root, args.path) : ".";
  // ripgrep 系统里已有；-S 智能大小写，限制列宽和结果数防刷屏
  // rg 自动尊重 .gitignore；项目根放 .foxagent/ignore 可额外排除目录
  let flags = "";
  if (args.glob) flags += ` -g ${shq(args.glob)}`;
  try {
    await fs.stat(path.join(root, ".foxagent", "ignore"));
    flags += " --ignore-file .foxagent/ignore";
  } catch {}
  // --max-count 已限量，无需再管道 head（head 还会引入平台/注入面）
  const cmd = `rg -n --no-heading -S --max-columns 250 --max-count 50${flags} ${shq(
    args.pattern
  )} ${args.path ? shq(target) : "."}`;
  const out = await runExec(cmd, root, 30000);
  if (out.trim() === "" || out.trim() === "（无输出）") return "没有搜到匹配内容";
  return truncate(out);
}

async function runCommandTool(root: string, args: any, io: ToolIO): Promise<string> {
  if (isDangerous(args.command)) {
    const ok = await io.confirmCommand(args.command);
    if (!ok) return "用户拒绝了这条命令。请换一种方式，或用 ask 工具询问指挥者的意见。";
  }
  return truncate(await runExec(args.command, root, 120000));
}

const OFFLINE_ANSWER =
  "（指挥者不在线，无法回答。请按最合理的理解继续，并在最终汇报里说明你做了什么假设。）";

async function askTool(args: any, io: ToolIO): Promise<string> {
  const question = String(args.question || "").trim();
  if (!question) throw new Error("question 不能为空");
  if (!io.askUser) return OFFLINE_ANSWER;
  const answer = await io.askUser(question);
  if (answer === null) return OFFLINE_ANSWER;
  return `指挥者回答：${answer}`;
}

export async function executeTool(
  name: string,
  args: any,
  root: string,
  io: ToolIO
): Promise<string> {
  try {
    switch (name) {
      case "read_file":
        return await readFileTool(root, args);
      case "edit_file":
        return await editFileTool(root, args, io);
      case "write_file":
        return await writeFileTool(root, args, io);
      case "list_dir":
        return await listDirTool(root, args);
      case "search":
        return await searchTool(root, args);
      case "ask":
        return await askTool(args, io);
      case "run_command":
        return await runCommandTool(root, args, io);
      default:
        return `错误：不存在名为 ${name} 的工具`;
    }
  } catch (e: any) {
    return `错误：${e.message || e}`;
  }
}
