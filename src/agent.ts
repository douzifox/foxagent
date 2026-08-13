import { TOOLS, executeTool, ToolIO } from "./tools";
import { compactIfNeeded, estimateTokens } from "./context";
import { Action } from "./journal";

// 只走 OpenAI 兼容格式（DeepSeek、各类网关的 /v1 端点）。
// 内部消息里 arguments 存对象、thinking 单独字段，发送时在 toOpenAI 里转换
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: any[];
  tool_name?: string;
  tool_call_id?: string;
  // API usage 带回的计量（token 预算 + 缓存命中率观测用）。读取后立即删除，不落盘进会话
  promptTokens?: number;
  cacheHitTokens?: number; // DeepSeek 的 prompt_cache_hit_tokens
}

export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "delta"; kind: "text" | "thinking"; text: string } // 流式增量
  | { type: "delta_end" } // 一段流式输出结束（界面封口/换行）
  | { type: "tool"; name: string; args: any }
  | { type: "tool_result"; name: string; output: string }
  | { type: "status"; text: string }
  | { type: "error"; text: string };

export interface AgentOptions extends ToolIO {
  host: string;
  apiKey: string;
  model: string;
  numCtx: number; // 仅用于上下文压缩阈值
  temperature: number;
  maxIters: number; // 防死循环兜底（主预算是 maxTokens，见决策 16）
  maxTokens: number; // 本次任务的累计 prompt token 预算；80% 提醒收敛，耗尽走总结轮硬断
  root: string;
  messages: ChatMessage[];
  onEvent: (e: AgentEvent) => void;
  signal?: AbortSignal; // 用户打断（CLI Ctrl+C / 面板停止按钮）
}

function toOpenAI(m: ChatMessage): any {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.tool_call_id || "", content: m.content };
  }
  if (m.role === "assistant") {
    const out: any = { role: "assistant", content: m.content || "" };
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((c: any, i: number) => ({
        id: c.id || `call_${i}`,
        type: "function",
        function: {
          name: c.function?.name,
          arguments: JSON.stringify(c.function?.arguments ?? {}),
        },
      }));
    }
    return out;
  }
  return { role: m.role, content: m.content };
}

function safeParseArgs(s: any): any {
  if (typeof s !== "string") return s ?? {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

interface ModelConfig {
  host: string;
  apiKey: string;
  model: string;
  temperature: number;
}

// 单次请求，返回统一的内部消息格式。
// 传了 onDelta 就走流式（SSE）：思考/正文增量实时回调，工具调用分片在内部拼装
export async function chatOnce(
  cfg: ModelConfig,
  messages: ChatMessage[],
  withTools: boolean,
  onDelta?: (kind: "text" | "thinking", text: string) => void,
  signal?: AbortSignal
): Promise<ChatMessage> {
  const base = cfg.host.replace(/\/+$/, "");
  const url = base.endsWith("/v1")
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: messages.map(toOpenAI),
        temperature: cfg.temperature,
        ...(withTools ? { tools: TOOLS } : {}),
        // include_usage：流式也在最后一个 chunk 返回 usage（预算计量用真值 + 缓存命中观测）
        ...(onDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
      }),
    });
  } catch (e: any) {
    if (e?.name !== "AbortError") e.retryable = true; // 网络层错误（连接被拒/DNS/断流）值得重试
    throw e;
  }
  if (!res.ok) {
    const err: any = new Error(`接口返回 ${res.status}：${await res.text()}`);
    err.status = res.status; // 给重试层判断用
    throw err;
  }

  if (!onDelta) {
    const data: any = await res.json();
    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new Error("回复被输出长度上限截断（finish_reason=length），内容不完整");
    }
    const m = choice?.message ?? {};
    const out: ChatMessage = {
      role: "assistant",
      content: m.content || "",
      // DeepSeek 推理模型等的思考在 reasoning_content 字段
      thinking: m.reasoning_content || undefined,
      promptTokens: data.usage?.prompt_tokens || undefined,
      cacheHitTokens: data.usage?.prompt_cache_hit_tokens || undefined,
    };
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((c: any, i: number) => ({
        id: c.id || `call_${i}`,
        function: {
          name: c.function?.name,
          arguments: safeParseArgs(c.function?.arguments),
        },
      }));
    }
    return out;
  }

  // 流式：解析 SSE，正文/思考边到边吐，tool_calls 按 index 聚合分片。
  // 流中的 error 对象和 finish_reason=length 都必须上抛——静默吞掉会把失败当成功
  let content = "";
  let thinking = "";
  let finishReason: string | undefined;
  let promptTokens: number | undefined; // usage 在最后一个 SSE chunk（include_usage 已开）
  let cacheHitTokens: number | undefined;
  const slots: { id?: string; name: string; args: string }[] = [];
  const processLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.error) {
      throw new Error(json.error.message || JSON.stringify(json.error));
    }
    if (json.usage?.prompt_tokens) promptTokens = json.usage.prompt_tokens;
    if (json.usage?.prompt_cache_hit_tokens) cacheHitTokens = json.usage.prompt_cache_hit_tokens;
    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    if (delta.reasoning_content) {
      thinking += delta.reasoning_content;
      onDelta("thinking", delta.reasoning_content);
    }
    if (delta.content) {
      content += delta.content;
      onDelta("text", delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? 0;
      if (!slots[i]) slots[i] = { name: "", args: "" };
      if (tc.id) slots[i].id = tc.id;
      if (tc.function?.name) slots[i].name += tc.function.name;
      if (tc.function?.arguments) slots[i].args += tc.function.arguments;
    }
  };
  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) processLine(line);
  }
  // 冲刷解码器与缓冲区残留（部分服务商最后一条 data 后不带换行就关流）
  buf += decoder.decode();
  if (buf.trim()) processLine(buf);

  if (finishReason === "length") {
    throw new Error("回复被输出长度上限截断（finish_reason=length），内容不完整");
  }
  const out: ChatMessage = {
    role: "assistant",
    content,
    thinking: thinking || undefined,
    promptTokens,
    cacheHitTokens,
  };
  const calls = slots.filter(Boolean);
  if (calls.length) {
    // 缺 id 的调用当场补上稳定 id，保证后续 tool 结果消息能正确配对
    out.tool_calls = calls.map((s, i) => ({
      id: s.id || `call_${i}`,
      function: { name: s.name, arguments: safeParseArgs(s.args) },
    }));
  }
  return out;
}

// ---- 上游重试 ----
// 503/429/网络抖动是常态，不重试就翻车（MCP 指挥实战里第二次任务因 503 颗粒无收）。
// 指数退避 3 次。不设备用模型——同一 host 上的备用和主力一起挂，是伪冗余（决策 19）
const RETRY_DELAYS = [2000, 8000, 30000];

function isRetryable(e: any): boolean {
  if (e?.name === "AbortError") return false;
  if (e?.retryable) return true;
  return [429, 500, 502, 503, 504].includes(e?.status);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const e: any = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface RetryIO {
  onEvent: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

export async function chatWithRetry(
  cfg: ModelConfig,
  io: RetryIO,
  messages: ChatMessage[],
  withTools: boolean,
  onDelta?: (kind: "text" | "thinking", text: string) => void
): Promise<ChatMessage> {
  // 流式已经吐过增量的失败不能重试——重放会让调用方看到重复内容
  let emitted = false;
  const wrapDelta = onDelta
    ? (kind: "text" | "thinking", text: string) => {
        emitted = true;
        onDelta(kind, text);
      }
    : undefined;
  for (let attempt = 0; ; attempt++) {
    emitted = false;
    try {
      return await chatOnce(cfg, messages, withTools, wrapDelta, io.signal);
    } catch (e: any) {
      if (e?.name === "AbortError" || emitted || !isRetryable(e)) throw e;
      if (attempt >= RETRY_DELAYS.length) throw e; // 重试耗尽
      const delay = RETRY_DELAYS[attempt];
      io.onEvent({
        type: "status",
        text: `上游繁忙（${e.status ?? "网络错误"}），${delay / 1000} 秒后重试 ${attempt + 1}/${RETRY_DELAYS.length}…`,
      });
      await sleep(delay, io.signal);
    }
  }
}

// 失败判定的唯一来源——journal 标注和 pitfall 记录共用，避免两处结论矛盾
function isFailedOutput(output: string): boolean {
  return (
    output.startsWith("错误") ||
    output.startsWith("用户拒绝") ||
    /（退出码 [1-9]/.test(output)
  );
}

// 有副作用的工具 → 日志动作；只读工具不记（噪音）
function toAction(name: string, args: any, output: string): Action | undefined {
  const failed = isFailedOutput(output);
  if (name === "edit_file") return { kind: "edit", target: args.path, failed };
  if (name === "write_file") return { kind: "write", target: args.path, failed };
  if (name === "run_command") return { kind: "run", target: String(args.command), failed };
  return undefined;
}

// 踩坑收尾轮：在会话历史副本上追加内务指令，让模型判断坑值不值得存进项目记忆
async function wrapUp(
  cfg: ModelConfig,
  opts: AgentOptions,
  wrapMessages: ChatMessage[],
  pitfalls: string[]
): Promise<void> {
  opts.onEvent({ type: "status", text: "收尾：沉淀本轮踩的坑…" });
  wrapMessages.push({
    role: "user",
    content:
      `【系统收尾】本轮工作踩过以下坑：\n${pitfalls.map((p) => `- ${p}`).join("\n")}\n` +
      `请判断：其中有没有对以后做别的任务仍有价值的教训（项目的隐藏约束、环境的特殊情况）？` +
      `有 → 按记忆规矩存进项目记忆并更新索引；` +
      `只是一次性失误（如笔误、已当场纠正的参数错误）→ 直接回复"无需记录"，不要硬记。`,
  });
  for (let i = 0; i < 5; i++) {
    let msg: ChatMessage;
    try {
      msg = await chatWithRetry(cfg, { onEvent: opts.onEvent, signal: opts.signal }, wrapMessages, true);
    } catch {
      return; // 收尾失败不影响主任务
    }
    wrapMessages.push(msg);
    if (msg.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        const name = call.function?.name;
        const args = call.function?.arguments ?? {};
        opts.onEvent({ type: "tool", name, args });
        const output = await executeTool(name, args, opts.root, {
          confirmCommand: opts.confirmCommand,
          showEdit: opts.showEdit,
          askUser: opts.askUser,
        });
        opts.onEvent({ type: "tool_result", name, output });
        wrapMessages.push({
          role: "tool",
          tool_name: name,
          tool_call_id: call.id,
          content: output,
        });
      }
      continue;
    }
    if (msg.content) opts.onEvent({ type: "status", text: `收尾：${msg.content.slice(0, 80)}` });
    return;
  }
}

// 本轮的动作与坑——由调用方跨轮累积。
// committed = 本轮有成功的 git commit（任务完成的确定性信号，调用方据此立即落盘 journal）
export interface RoundResult {
  actions: Action[];
  pitfalls: string[];
  outcome: string;
  committed: boolean;
  tokensSpent: number; // 本轮任务累计 prompt token（预算口径：usage 真值优先，缺失按估算）
  cacheHitRate?: number; // 接口缓存命中率（0~1，仅在 usage 有数据时给出）——调压缩阈值的实测依据
}

// 核心循环：问模型 → 它要用工具就执行并回传 → 直到它开口说话
export async function runAgent(opts: AgentOptions): Promise<RoundResult> {
  const { messages, onEvent } = opts;
  const cfg: ModelConfig = {
    host: opts.host,
    apiKey: opts.apiKey,
    model: opts.model,
    temperature: opts.temperature,
  };
  const actions: Action[] = [];
  const pitfalls: string[] = [];
  let committed = false;
  // 累计 token 预算（决策 16）：每轮累加发送的 prompt 大小，优先 API usage 真值，缺失退回字符估算。
  // 只计主循环（成本主体）；压缩/收尾轮的调用次数有限，不计入
  let spentTokens = 0;
  let budgetWarned = false;
  let interruptReason: string | undefined;
  // usage 真值的累计（缓存命中率只能按真值算，估算轮不进分母）
  let usagePrompt = 0;
  let usageHit = 0;
  const metrics = () => ({
    tokensSpent: spentTokens,
    cacheHitRate: usagePrompt > 0 ? Math.round((usageHit / usagePrompt) * 1000) / 1000 : undefined,
  });

  for (let i = 0; i < opts.maxIters; i++) {
    await compactIfNeeded(messages, {
      numCtx: opts.numCtx,
      onEvent,
      complete: async (prompt) => {
        const m = await chatWithRetry(
          { ...cfg, temperature: 0.1 },
          { onEvent, signal: opts.signal },
          [{ role: "user", content: prompt }],
          false
        );
        return m.content || "";
      },
    });

    if (opts.signal?.aborted) {
      onEvent({ type: "status", text: "已被打断" });
      return { actions, pitfalls, outcome: "被用户打断", committed, ...metrics() };
    }

    // token 预算是主限：耗尽 → 跳去总结轮硬断；过 80% → 注入一次收敛提醒。
    // 提醒必须按「本轮末的预测水位」判断（累计 + 本轮将发送的 prompt）：
    // 累计消耗平方级增长，后期单轮增量就超过预算的 20%，只看已累计值会整轮跨过 80% 线、
    // 提醒永远不触发（lvbc 验收实测）。预测式保证硬断前至少有一轮带着提醒跑
    if (spentTokens >= opts.maxTokens) {
      interruptReason = `达到 token 预算上限（已消耗约 ${spentTokens}，预算 ${opts.maxTokens}，FOXAGENT_MAX_TOKENS 可调）`;
      break;
    }
    const projected = spentTokens + estimateTokens(messages);
    if (!budgetWarned && projected >= opts.maxTokens * 0.8) {
      budgetWarned = true;
      messages.push({
        role: "user",
        content:
          "【系统提醒】本任务的 token 预算即将超过 80%，耗尽后任务会被强制中断。" +
          "请立即收敛：把剩余操作尽量合并到同一轮批量执行，停止大范围浏览，" +
          "完成最要紧的产出并给出最终结论；确实做不完就直接汇报当前进展、关键发现和剩余工作。",
      });
      onEvent({
        type: "status",
        text: `token 预算将过 80%（已用约 ${spentTokens}，本轮末预计 ${projected}/${opts.maxTokens}），已提醒模型收敛`,
      });
    }

    // 轮数快耗尽时明确提醒模型收敛——确定性机制，不指望它自己数轮数。
    // 细读型任务最容易在这里烧完次数被硬断（MCP 指挥实战踩过）。
    // 上限本来就小的场景不注入，免得一开场就催收。放在压缩之后，避免刚注入就被总结掉
    if (opts.maxIters - i === 5 && opts.maxIters > 10) {
      messages.push({
        role: "user",
        content:
          "【系统提醒】剩余响应轮数只有 5 轮，之后任务会被强制中断。一轮内批量发起多个工具调用只算一轮——" +
          "请立即收敛：把剩余操作尽量合并到同一轮批量执行，停止大范围浏览，" +
          "完成最要紧的产出并给出最终结论；确实做不完就直接汇报当前进展、关键发现和剩余工作。",
      });
      onEvent({ type: "status", text: "剩余循环次数不多，已提醒模型收敛" });
    }

    let msg: ChatMessage;
    let sawDelta = false;
    const estBefore = estimateTokens(messages); // usage 缺失时的计量兜底（发送前的上下文大小）
    try {
      msg = await chatWithRetry(
        cfg,
        { onEvent, signal: opts.signal },
        messages,
        true,
        (kind, text) => {
          sawDelta = true;
          onEvent({ type: "delta", kind, text });
        }
      );
    } catch (e: any) {
      if (sawDelta) onEvent({ type: "delta_end" });
      if (opts.signal?.aborted || e.name === "AbortError") {
        onEvent({ type: "status", text: "已被打断" });
        return { actions, pitfalls, outcome: "被用户打断", committed, ...metrics() };
      }
      onEvent({ type: "error", text: `模型调用失败（${opts.host}）：${e.message || e}` });
      return { actions, pitfalls, outcome: `中断：模型调用失败（${e.message || e}）`, committed, ...metrics() };
    }
    if (sawDelta) onEvent({ type: "delta_end" });
    spentTokens += msg.promptTokens ?? estBefore;
    if (msg.promptTokens) {
      usagePrompt += msg.promptTokens;
      usageHit += msg.cacheHitTokens ?? 0;
    }
    delete msg.promptTokens; // 临时字段，不落盘进会话
    delete msg.cacheHitTokens;
    messages.push(msg);

    // 流式时增量已经实时显示过，不再重发完整段落
    if (msg.thinking && !sawDelta) {
      onEvent({ type: "thinking", text: msg.thinking });
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const call of msg.tool_calls) {
        const name = call.function?.name;
        const args = call.function?.arguments ?? {};
        // 打断后剩余的调用不执行，但必须补上结果消息保持配对，否则下轮请求 400
        if (opts.signal?.aborted) {
          messages.push({
            role: "tool",
            tool_name: name,
            tool_call_id: call.id,
            content: "用户已打断，此调用未执行。",
          });
          continue;
        }
        onEvent({ type: "tool", name, args });
        const output = await executeTool(name, args, opts.root, {
          confirmCommand: opts.confirmCommand,
          showEdit: opts.showEdit,
          askUser: opts.askUser,
        });
        onEvent({ type: "tool_result", name, output });
        const action = toAction(name, args, output);
        if (action) actions.push(action);
        const failed = isFailedOutput(output);
        if (failed && !output.startsWith("用户拒绝")) {
          const target = args.path || String(args.command || args.pattern || "").slice(0, 40);
          pitfalls.push(`${name} ${target}：${output.split("\n")[0]}`);
        }
        if (
          name === "run_command" &&
          /git\s+commit\b/.test(String(args.command)) &&
          !/--dry-run/.test(String(args.command)) &&
          !failed
        ) {
          committed = true;
        }
        messages.push({
          role: "tool",
          tool_name: name,
          tool_call_id: call.id,
          content: output,
        });
      }
      continue;
    }

    if (msg.content && !sawDelta) {
      onEvent({ type: "text", text: msg.content });
    }
    if (!msg.content && !msg.tool_calls?.length) {
      onEvent({ type: "status", text: "（模型返回了空回复）" });
    }
    // 收尾：只有踩过坑的轮次才触发——把坑点名递给模型，判断是否值得沉淀进项目记忆。
    // 收尾对话用独立副本，不进正式会话历史（不污染上下文和缓存）
    if (pitfalls.length > 0) {
      await wrapUp(cfg, opts, [...messages], pitfalls);
    }
    return { actions, pitfalls, outcome: msg.content || "（完成，无文字回复）", committed, ...metrics() };
  }

  // 预算/轮数耗尽：硬断前让模型（不带工具）把进展说清楚——否则调用方只拿到一句「达到上限」，
  // 续会话都不知道从哪接。总结进正式会话，续跑时上下文里能看到自己中断过、说过什么
  if (!interruptReason) {
    interruptReason = `达到最大循环次数上限（${opts.maxIters}，FOXAGENT_MAX_ITERS 可调）`;
  }
  onEvent({ type: "error", text: `已${interruptReason}，先停下来。` });
  messages.push({
    role: "user",
    content:
      "【系统收尾】循环次数已耗尽，任务被强制中断，现在无法再使用工具。" +
      "请用纯文本简短总结：①已完成了什么 ②关键发现 ③还没做完什么、建议怎么继续。",
  });
  let summary = "";
  try {
    const m = await chatWithRetry(cfg, { onEvent, signal: opts.signal }, messages, false);
    summary = (m.content || "").trim();
  } catch {}
  if (summary) {
    messages.push({ role: "assistant", content: summary });
    onEvent({ type: "text", text: summary });
  } else {
    messages.pop(); // 总结没拿到，别把悬空的收尾指令留在会话里
  }
  return {
    actions,
    pitfalls,
    outcome: `中断：${interruptReason}` + (summary ? `。收敛总结：${summary}` : ""),
    committed,
    ...metrics(),
  };
}
