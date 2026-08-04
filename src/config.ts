// 配置只从环境变量读，密钥不落任何配置文件。
// 必须：FOXAGENT_HOST、FOXAGENT_API_KEY、FOXAGENT_MODEL
// 可选：FOXAGENT_NUM_CTX（压缩阈值，默认按模型窗口推断）、FOXAGENT_TEMPERATURE（默认 0.3）、
//       FOXAGENT_MAX_ITERS（默认 25）
//
// 模型窗口约定（网关侧）：模型名默认 200k 上下文；1M 窗口的模型名带 [1m] 后缀，
// 例如 "deepseek-v4-flash[1m]"。这个后缀只是给客户端看的标记，发给 API 前必须剥离。
export interface FoxConfig {
  host: string;
  apiKey: string;
  model: string; // 已剥离 [1m] 标注的干净模型名，可直接发给 API
  fallbackModel?: string; // FOXAGENT_FALLBACK_MODEL：上游重试耗尽后的备用模型
  numCtx: number;
  temperature: number;
  maxIters: number;
}

const DEFAULT_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

// 从模型名解析真实窗口，并返回剥离标注后的干净名
export function parseModel(raw: string): { model: string; window: number } {
  const m = raw.match(/\s*\[1m\]\s*$/i);
  if (m) return { model: raw.slice(0, m.index).trim(), window: LARGE_WINDOW };
  return { model: raw.trim(), window: DEFAULT_WINDOW };
}

export function loadConfig(): FoxConfig {
  const host = process.env.FOXAGENT_HOST;
  const apiKey = process.env.FOXAGENT_API_KEY;
  const model = process.env.FOXAGENT_MODEL;
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
        `export FOXAGENT_MODEL=deepseek-chat`
    );
  }
  // 数值环境变量：拼错（NaN）或超范围时报错，不静默用怪值
  const num = (name: string, def: number, min: number, max: number): number => {
    const raw = process.env[name];
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
  const defaultCtx = num("FOXAGENT_NUM_CTX", DEFAULT_WINDOW, 2048, 10_000_000);
  // 备用模型同样剥 [1m] 标注；它的窗口不参与压缩阈值（阈值按主模型算，偏保守无害）
  const fallbackRaw = process.env.FOXAGENT_FALLBACK_MODEL;
  return {
    host: host!,
    apiKey: apiKey!,
    model: cleanModel,
    fallbackModel: fallbackRaw ? parseModel(fallbackRaw).model : undefined,
    numCtx: modelWindow > DEFAULT_WINDOW ? modelWindow : defaultCtx,
    temperature: num("FOXAGENT_TEMPERATURE", 0.3, 0, 2),
    maxIters: num("FOXAGENT_MAX_ITERS", 25, 1, 1000),
  };
}
