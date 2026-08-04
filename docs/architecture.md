# 架构

## 一次任务的生命周期

```
用户输入（CLI readline / 面板 webview）
  → 入口层组装 AgentOptions（config + root + messages + 回调）
  → runAgent 循环：
      compactIfNeeded（估算超 numCtx 70% 时全量总结压缩）
      chatOnce（POST {host}/v1/chat/completions，流式 SSE）
      ├─ 模型返回 tool_calls → executeTool 逐个执行 → 结果 push 回 messages → 继续循环
      └─ 模型说话 → 结束本轮
  → 踩过坑（pitfalls 非空）→ wrapUp 收尾轮（历史副本，不进正式会话）
  → 返回 RoundResult { actions, pitfalls, outcome, committed }
  → 入口层：mergePending 累积 → committed 或会话切换/退出时 flushJournal
  → saveSession
```

## 消息格式（关键约定）

内部统一 **Ollama 风格**存储：`tool_calls[].function.arguments` 是**对象**、
思考在 `thinking` 字段、工具结果消息带 `tool_name` + `tool_call_id`。
发送给接口时 `toOpenAI()` 转换（arguments 序列化为字符串、思考字段剥除）；
接口响应转回内部格式（`reasoning_content` → thinking、arguments 反序列化）。
会话文件里存的就是内部格式，向前兼容要保这个结构。

## 事件流（AgentEvent）

runAgent 通过 `onEvent` 单向推事件，入口层各自渲染：
`delta`（流式增量，kind=text|thinking）/ `delta_end` / `thinking` / `text`
（后两个仅非流式时发，流式下已由 delta 覆盖）/ `tool` / `tool_result` /
`status` / `error`。UI 不回调 agent——用户确认走 ToolIO 的回调
（confirmCommand），打断走 AbortSignal。

## ToolIO 解耦

工具层不知道界面是谁：需要用户点头的操作走 `confirmCommand`（只有危险命令），
diff 展示走 `showEdit`（通知性，不阻塞）。CLI 实现为终端问答/打印，
插件实现为弹窗/面板消息，`-p` 模式实现为自动拒绝+打印。

## 数据落盘（~/.foxagent/，见 src/paths.ts）

```
~/.foxagent/FOXAGENT.md                    全局指示（用户写，全文注入每次会话）
~/.foxagent/projects/<路径编码>/
    memory/MEMORY.md                       项目记忆索引（注入）
    memory/<slug>.md                       每条记忆一个文件（按需读）
    sessions/<id>.json                     会话（含 pending journal 暂存）
    journal.md                             工作档案（任务粒度，全文注入）
```

项目路径编码：`root.replace(/[\/\\:]/g, "-")`。项目目录本身零污染。

## 路径安全（tools.ts resolveSafe）

工作区外只放行 `~/.foxagent/`。两个兜底重定向（模型爱用相对路径）：
相对 `memory/…`、`MEMORY.md`、`journal.md` 在工作区不存在同名文件时，
自动映射到该项目的数据目录。

## 系统提示词组装（prompt.ts）

家规模板（可被工作区 system-prompt.md 覆盖，取 `=== 提示词正文 ===` 标记间内容）
→ 填充 os/cwd/date/路径占位符 → 追加注入：全局指示全文、项目记忆索引、
journal 全文。会话内提示词不变（前缀稳定利于接口缓存）；新会话重建。

## 上下文压缩（context.ts）

估算：字符数/3（宁高勿低），优先级低于真实用量（没接）。超 `numCtx * 0.7` 触发：
取安全边界（不切断 assistant→tool 配对，保最近 6 条），把前段**完整序列化**
（工具输出不截断——它们是核心证据）交模型总结成备忘，替换原文。
总结失败退化为硬裁剪旧工具输出。压缩会改写历史 → 接口缓存该轮失效（已知代价）。

## 模型窗口约定

模型名带 `[1m]` 后缀 = 1M 窗口，不带 = 200k。`config.ts:parseModel()` 负责剥离标注
并推断窗口。`FOXAGENT_NUM_CTX` 只覆盖默认值（200k），推断出 1M 时以推断值为准。
压缩阈值 = numCtx × 70%，窗口越大压缩越晚、缓存命中越高。

## 已知模型边界（gemma4:26b-mlx）

- 多步新家规（完成即 commit、顺口约定自动记忆）不执行——提示词留着等大模型
- 曾把 read_file 行号前缀抄进 old_string——已有机制检测报错，模型能自愈
- 报错文案写成「指导下一步」的形式，它的自我纠正成功率高
