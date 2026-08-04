import { TOOLS, executeTool, ToolIO } from "./tools";
import { compactIfNeeded } from "./context";
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
  maxIters: number;
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
  const res = await fetch(url, {
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
      ...(onDelta ? { stream: true } : {}),
    }),
  });
  if (!res.ok) throw new Error(`接口返回 ${res.status}：${await res.text()}`);

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
      msg = await chatOnce(cfg, wrapMessages, true);
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

  for (let i = 0; i < opts.maxIters; i++) {
    await compactIfNeeded(messages, {
      numCtx: opts.numCtx,
      onEvent,
      complete: async (prompt) => {
        const m = await chatOnce(
          { ...cfg, temperature: 0.1 },
          [{ role: "user", content: prompt }],
          false
        );
        return m.content || "";
      },
    });

    if (opts.signal?.aborted) {
      onEvent({ type: "status", text: "已被打断" });
      return { actions, pitfalls, outcome: "被用户打断", committed };
    }

    let msg: ChatMessage;
    let sawDelta = false;
    try {
      msg = await chatOnce(
        cfg,
        messages,
        true,
        (kind, text) => {
          sawDelta = true;
          onEvent({ type: "delta", kind, text });
        },
        opts.signal
      );
    } catch (e: any) {
      if (sawDelta) onEvent({ type: "delta_end" });
      if (opts.signal?.aborted || e.name === "AbortError") {
        onEvent({ type: "status", text: "已被打断" });
        return { actions, pitfalls, outcome: "被用户打断", committed };
      }
      onEvent({ type: "error", text: `模型调用失败（${opts.host}）：${e.message || e}` });
      return { actions, pitfalls, outcome: `中断：模型调用失败（${e.message || e}）`, committed };
    }
    if (sawDelta) onEvent({ type: "delta_end" });
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
    return { actions, pitfalls, outcome: msg.content || "（完成，无文字回复）", committed };
  }

  onEvent({
    type: "error",
    text: `已达到单轮最大循环次数（${opts.maxIters}），先停下来。可以用 FOXAGENT_MAX_ITERS 调大。`,
  });
  return { actions, pitfalls, outcome: `中断：达到最大循环次数 ${opts.maxIters}`, committed };
}
