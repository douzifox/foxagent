import type { ChatMessage, AgentEvent } from "./agent";

// 粗略估算：中英混合代码文本约 3 字符 = 1 token，宁可高估不可低估
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content || "").length + (m.thinking || "").length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 3);
}

// 找一个不切断 assistant(tool_calls) → tool 配对的安全分界点：
// 从 keepTail 处向前退，保证保留段不以孤儿 tool 消息开头
function safeBoundary(messages: ChatMessage[], keepTail: number): number {
  let idx = Math.max(1, messages.length - keepTail);
  while (idx < messages.length && messages[idx].role === "tool") idx++;
  return idx;
}

// 完整序列化，工具结果不截断——总结的质量取决于输入的完整性
function serialize(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "tool") return `[工具 ${m.tool_name} 结果]\n${m.content}`;
      if (m.tool_calls?.length)
        return `[assistant 调用工具] ${m.tool_calls
          .map((c) => `${c.function?.name}(${JSON.stringify(c.function?.arguments)})`)
          .join("; ")}`;
      return `[${m.role}] ${m.content}`;
    })
    .join("\n\n");
}

export interface CompactOptions {
  numCtx: number;
  onEvent: (e: AgentEvent) => void;
  // 由调用方提供"发一段提示词拿回复"的能力，压缩逻辑不关心背后是哪家模型
  complete: (prompt: string) => Promise<string>;
}

// 一步到位的总结压缩：趁历史还完整（信息未经任何裁剪）时，
// 让模型基于全量上下文做高质量总结，替换掉前段原文。
// 工具输出是干活的核心证据，绝不预先裁剪——那会让后续总结变成对残缺历史的总结
export async function compactIfNeeded(
  messages: ChatMessage[],
  opts: CompactOptions
): Promise<void> {
  // 90% 水位才压（对齐 CC 的 auto-compact，决策 18）：压缩有损，原始细节尽量多留；
  // DeepSeek 的上下文缓存把长历史重复发送的成本摊薄了，晚压缩不再昂贵。
  // 该检查在每轮发送前执行，估算的 messages 就是即将发送的完整 prompt（上轮工具
  // 输出已包含），天然是预测式判断——不存在"单轮大增量跳过水位线直发"的窗口
  const budget = opts.numCtx * 0.9;
  if (estimateTokens(messages) < budget) return;

  const boundary = safeBoundary(messages, 6);
  const toSummarize = messages.slice(1, boundary);
  if (toSummarize.length === 0) return;

  opts.onEvent({ type: "status", text: "上下文快满了，正在总结压缩…" });

  // 总结失败或返回空时的兜底：狠裁旧工具输出，保证还能继续干活
  const hardTrim = () => {
    for (let i = 1; i < boundary; i++) {
      const m = messages[i];
      if (m.role === "tool" && m.content.length > 100) {
        m.content = m.content.slice(0, 100) + "…（已裁剪）";
      }
    }
  };

  let summary: string;
  try {
    summary = await opts.complete(
      "请把下面这段编码助手的工作对话压缩成详实的备忘，供助手接着干活用。" +
        "必须保留：用户的原始需求和所有明确要求、已经完成的修改（哪个文件改了什么）、" +
        "工具调用中发现的关键信息（重要代码片段的位置和内容要点、关键文件和函数的结构）、" +
        "当前正在进行到哪一步、遇到的未解决问题。" +
        "省略：失败后已纠正的尝试过程、与任务无关的内容。直接输出备忘内容：\n\n" +
        serialize(toSummarize)
    );
  } catch (e: any) {
    hardTrim();
    return;
  }

  if (!summary.trim()) {
    // 空摘要不能静默放过：不处理的话每轮都会白白重试一次总结
    hardTrim();
    return;
  }

  messages.splice(1, boundary - 1, {
    role: "user",
    content: `【以下是此前对话的摘要，原文已因上下文限制省略】\n${summary}`,
  });
  opts.onEvent({ type: "status", text: "上下文已压缩" });
}
