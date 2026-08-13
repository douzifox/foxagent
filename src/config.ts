// 配置以环境变量为主，缺失时兜底读 ~/.config/foxagent/env（KEY=VALUE，环境变量优先）。
// 密钥红线是不进项目目录；主目录配置可落盘（决策 4 修订）。
// 必须：FOXAGENT_HOST、FOXAGENT_API_KEY、FOXAGENT_MODEL
// 可选：FOXAGENT_NUM_CTX（压缩阈值，默认按模型窗口推断）、FOXAGENT_TEMPERATURE（默认 0.3）、
//       FOXAGENT_MAX_TOKENS（任务累计 token 预算，默认 = 窗口 × 5，一般不用设——
//       它同时是 MCP fox_submit maxTokens 参数的透传通道）、FOXAGENT_MAX_ITERS（防死循环兜底，默认 500）
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
//
// 模型窗口约定（网关侧）：模型名默认 200k 上下文；1M 窗口的模型名带 [1m] 后缀，
// 例如 "deepseek-v4-flash[1m]"。这个后缀只是给客户端看的标记，发给 API 前必须剥离。
export interface FoxConfig {
  host: string;
  apiKey: string;
  model: string; // 已剥离 [1m] 标注的干净模型名，可直接发给 API
  numCtx: number; // 压缩触发窗口（[1m] 时跟随抬到 1M，否则 200k / NUM_CTX 覆盖）
  temperature: number;
  maxIters: number; // 防死循环兜底（主预算是 maxTokens）
  maxTokens: number; // 任务累计 prompt token 预算（决策 16）
}

const DEFAULT_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

// 从模型名解析真实窗口，并返回剥离标注后的干净名
export function parseModel(raw: string): { model: string; window: number } {
  const m = raw.match(/\s*\[1m\]\s*$/i);
  if (m) return { model: raw.slice(0, m.index).trim(), window: LARGE_WINDOW };
  return { model: raw.trim(), window: DEFAULT_WINDOW };
}

// 兜底文件：GUI 启动的进程（MCP 服务器、双击打开的 VS Code）读不到 shell 配置，
// 环境变量断链时从这里救。格式：每行 KEY=VALUE，# 开头是注释
function loadEnvFallback(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = fs.readFileSync(path.join(os.homedir(), ".config", "foxagent", "env"), "utf-8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch {}
  return out;
}

export function loadConfig(): FoxConfig {
  const fallback = loadEnvFallback();
  const get = (name: string) => process.env[name] || fallback[name];
  const host = get("FOXAGENT_HOST");
  const apiKey = get("FOXAGENT_API_KEY");
  const model = get("FOXAGENT_MODEL");
  const missing = [
    !host && "FOXAGENT_HOST",
    !apiKey && "FOXAGENT_API_KEY",
    !model && "FOXAGENT_MODEL",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `缺少环境变量：${missing.join("、")}。请在 shell 配置（如 ~/.zshrc）里设置，例如：\n` +
        `export FOXAGENT_HOST=https://api.deepseek.com\n` +
        `export FOXAGENT_API_KEY=sk-xxx\n` +
        `export FOXAGENT_MODEL=deepseek-chat\n` +
        `如果通过 MCP 调用，请在 MCP 注册配置的 env 字段里设置；\n` +
        `GUI 启动读不到 shell 配置时，也可写入兜底文件 ~/.config/foxagent/env（KEY=VALUE 每行一条）`
    );
  }
  // 数值环境变量：拼错（NaN）或超范围时报错，不静默用怪值
  const num = (name: string, def: number, min: number, max: number): number => {
    const raw = get(name);
    if (raw === undefined || raw === "") return def;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < min || v > max) {
      throw new Error(`环境变量 ${name}=${raw} 无效，应为 ${min}~${max} 之间的数值`);
    }
    return v;
  };
  // 从模型名推断窗口并剥离 [1m] 标注。
  // NUM_CTX 只覆盖默认值（200k）：模型带 [1m] 推断出 1M 时，以推断值为准不受覆盖；
  // 不带标注时取 NUM_CTX（没设就 200k）
  const { model: cleanModel, window: modelWindow } = parseModel(model!);
  // [1m] 是整套 1M 模式的开关（决策 14/17）：压缩窗口跟随抬高。
  // 想要早压缩就用不带 [1m] 的模型名，不另设解耦配置
  const defaultCtx = num("FOXAGENT_NUM_CTX", DEFAULT_WINDOW, 2048, 10_000_000);
  const numCtx = modelWindow > DEFAULT_WINDOW ? modelWindow : defaultCtx;
  return {
    host: host!,
    apiKey: apiKey!,
    model: cleanModel,
    numCtx,
    temperature: num("FOXAGENT_TEMPERATURE", 0.3, 0, 2),
    // 主预算按累计 token 计（决策 16），默认 = 模型真实窗口 × 5——换模型不用改配置，
    // 也不随压缩窗口缩水。轮数只是防死循环兜底：低 token 死循环按预算烧不完，靠它拦
    maxTokens: num("FOXAGENT_MAX_TOKENS", modelWindow * 5, 10_000, 1_000_000_000),
    maxIters: num("FOXAGENT_MAX_ITERS", 500, 1, 10_000),
  };
}
