# 架构

## 一次任务的生命周期

```
用户输入（CLI readline / -p 任务参数）
  → 入口层组装 AgentOptions（config + root + messages + 回调）
  → runAgent 循环：
      compactIfNeeded（估算超 numCtx 90% 时全量总结压缩；检查在发送前，天然预测式）
      chatOnce（POST {host}/v1/chat/completions，流式 SSE）
      ├─ 模型返回 tool_calls → executeTool 逐个执行 → 结果 push 回 messages → 继续循环
      └─ 模型说话 → 结束本轮
      （累计 prompt token 持续计量——优先 API usage 真值、缺失退回估算。
        成本护栏默认不限（决策 21）；显式设 maxTokens 时消耗过 80% 注入收敛提醒、
        耗尽硬断。轮数上限只防死循环，默认 500。两种硬断前都再给一次无工具的
        总结轮——进展总结进正式会话并拼进 outcome，续会话时上下文完整）
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
（confirmCommand），打断走 AbortSignal。onEvent 单向、UI 不回调的解耦
让入口层可插拔——曾经的 VS Code 插件形态就挂在这层上（已砍，决策 20）。

## ToolIO 解耦

工具层不知道界面是谁：需要用户点头的操作走 `confirmCommand`（只有危险命令），
diff 展示走 `showEdit`（通知性，不阻塞），模型主动提问走 `askUser`（ask 工具，
可缺省——没接线时如实告诉模型「指挥者不在线」）。CLI 实现为终端问答/打印，
`-p` 模式实现为哨兵协议（见下）。

## -p 模式哨兵协议 + MCP 服务器（mcp.ts）

`-p` 模式与调用方之间用 stdout/stdin 走行协议：

```
@@ASK@@{"type":"confirm"|"ask","question":...}   需要回答：危险命令确认 / ask 提问
                                                  ← stdin 一行回复（confirm 用 y/yes）
@@RESULT@@{outcome, filesChanged, committed,      结束时的结构化摘要：
           error, sessionId}                      成果与事故分离呈现
```

stdin 无人接（EOF）→ 确认当拒绝、提问当不在线，如实汇报。
退出码：0 = 有成果（含收尾翻车的部分成功），1 = 颗粒无收。

mcp.ts 把这层包成 MCP 五工具（按行 JSON 的 JSON-RPC，手写无 SDK）。
initialize 返回 server-level instructions（使用要领：工单写法、两种等待模式、
fox_sessions 续会话）——跨项目、跨 session 传播用法的唯一可靠渠道，
新连上的调用方不依赖各自的项目记忆。工具：
`fox_submit`（spawn 子进程立即返回 taskId 与生效预算 tokenBudget；可选
`maxTokens`/`maxIters` 经 FOXAGENT_* 环境变量透传给子进程）→ `fox_wait`（挂起直到任务
跳出 running 才返回，返回格式与 fox_status 一致；任务表里挂 waiters 回调，
状态跳变点唤醒；等满 timeoutSec（默认 300，clamp 5~570，须短于客户端
MCP 工具超时）返回 running + 续租 note，调用方再调一次续等）或
`fox_status`（增量输出，单次 ≤8k 字符，hasMore 提示继续取；哨兵行转成
waiting_for_input 状态；任何状态都带 logPath 供调用方 tail 判断假死；
result.outcome 以「中断」开头时附续跑指引 note）→ `fox_reply`（写回子进程
stdin）；`fox_sessions`（列项目历史会话——session.ts summarizeSessions，
含最近任务/最后回复摘要/轮数，供新调用方找回会话续聊）。
任务表仅内存，服务器进程没了任务即不存在。
完整轨迹落 `runs/<taskId>.log`，MCP 端只回传增量与摘要。

## 上游重试（agent.ts chatWithRetry）

503/429/5xx/网络错误指数退避重试 3 次（2s→8s→30s），每次发 status 事件；
流式已吐过增量的失败不重试（重放会重复输出）。不设备用模型——同 host 的
备用和主力一起挂，伪冗余（决策 19）。主循环、压缩、收尾轮都走这层。

## 数据落盘（~/.foxagent/，见 src/paths.ts）

```
~/.foxagent/FOXAGENT.md                    全局指示（用户写，全文注入每次会话）
~/.foxagent/projects/<路径编码>/
    memory/MEMORY.md                       项目记忆索引（注入）
    memory/<slug>.md                       每条记忆一个文件（按需读）
    sessions/<id>.json                     会话（含 pending journal 暂存）
    journal.md                             工作档案（任务粒度，全文注入）
    runs/<taskId>.log                      MCP 任务的完整轨迹（mcp.ts 写）
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

估算：字符数/3（宁高勿低）；预算计量已接 usage 真值，压缩判断仍用估算。
超 `numCtx * 0.9` 触发（决策 18）：
取安全边界（不切断 assistant→tool 配对，保最近 6 条），把前段**完整序列化**
（工具输出不截断——它们是核心证据）交模型总结成备忘，替换原文。
总结失败退化为硬裁剪旧工具输出。压缩会改写历史 → 接口缓存该轮失效（已知代价）。

## 模型窗口约定

模型名带 `[1m]` 后缀 = 1M 窗口，不带 = 200k。`config.ts:parseModel()` 负责剥离标注
并推断窗口。`[1m]` 是整套 1M 模式的开关（决策 17）：压缩窗口跟随抬到 1M，
token 预算基数也是 1M（默认预算 = 窗口 × 5）。`FOXAGENT_NUM_CTX` 只覆盖
默认值（200k），推断出 1M 时以推断值为准。压缩阈值 = numCtx × 90%（决策 18，
对齐 CC auto-compact），窗口越大压缩越晚、缓存命中越高；
想要早压缩就用不带 `[1m]` 的模型名。

## 已知模型边界（gemma4:26b-mlx）

- 多步新家规（完成即 commit、顺口约定自动记忆）不执行——提示词留着等大模型
- 曾把 read_file 行号前缀抄进 old_string——已有机制检测报错，模型能自愈
- 报错文案写成「指导下一步」的形式，它的自我纠正成功率高
