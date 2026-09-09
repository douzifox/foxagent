# FoxAgent 🦊

自己的 coding agent。终端 CLI + MCP 服务器（供 Claude Code 等 agent 派活的小助手）。
接任意 OpenAI 兼容接口（DeepSeek、各类网关、Ollama 的 /v1 端点）。

- 六工具：搜代码、读文件、精确修改、新建文件、列目录、跑命令
- 文件修改自动应用（红绿 diff 留痕），只有危险命令才弹确认
- 流式输出（打字机式实时显示思考和回复）
- 会话自动落盘可续聊，上下文快满时全量总结压缩
- 两层记忆：全局指示 + 项目记忆（索引制，每条一个文件）
- 工作档案：任务粒度自动记录，踩的坑重点标注，全文注入新会话
- Esc 打断 / ↑ 取回队列 / Ctrl+C 退出 / `-p` 非交互模式

## 配置

以环境变量为主；缺失时兜底读 `~/.config/foxagent/env`（KEY=VALUE 每行一条，
环境变量优先）——GUI 启动的进程（如 MCP 服务器）读不到
shell 配置时靠它。密钥红线：不进项目目录。

```bash
# 必须（写进 ~/.zshrc 或 Windows 系统环境变量）
export FOXAGENT_HOST=https://api.deepseek.com   # 或你的网关 /v1 地址
export FOXAGENT_API_KEY=sk-xxx
export FOXAGENT_MODEL=deepseek-v4-flash          # 模型名，见下方窗口约定

# 可选（默认值都合理，一般不用设）
export FOXAGENT_NUM_CTX=200000     # 压缩触发窗口（默认 200k；带 [1m] 的模型自动 1M）
export FOXAGENT_TEMPERATURE=0.3
export FOXAGENT_MAX_TOKENS=1000000 # 可选成本护栏（默认不限）；设了才生效：80% 提醒收敛，耗尽硬断前留进展总结
export FOXAGENT_MAX_ITERS=500      # 响应轮数上限，只防死循环（任务规模用 MAX_TOKENS 控制）
```

### 模型窗口约定

模型名默认按 **200k** 窗口处理。1M 窗口的模型加 `[1m]` 后缀：

```bash
export FOXAGENT_MODEL=deepseek-v4-flash         # → 200k 窗口
export FOXAGENT_MODEL=deepseek-v4-flash[1m]     # → 1M 窗口
```

`[1m]` 在发给 API 前自动剥离，不影响请求。它是**整套 1M 模式的开关**：
压缩窗口抬到 1M（压缩更晚、接口缓存命中更高）。`FOXAGENT_NUM_CTX` 只覆盖
默认值（200k）——带 `[1m]` 时以 1M 为准。想要早压缩（强制提炼、
每轮更快更省），用不带 `[1m]` 的模型名即可。实际生效的窗口和护栏
会显示在启动行里（护栏默认「不限」）。

## 终端 CLI

```bash
cd 你的项目
bun ~/Cli/src/cli.ts             # 默认继续该项目最近一次会话
bun ~/Cli/src/cli.ts --new       # 开新会话

# 会话内命令
/new          开新会话
/sessions     列出历史会话
/resume <id>  恢复指定会话
/exit         退出

# 操作
Esc           打断当前轮（会话保留）
Ctrl+C        退出（自动保存）
↑             干活时取回队列消息修改
输入回车      干活时排队，本轮结束后自动发送

# 非交互模式（供其他 agent 调用）
bun src/cli.ts -p "任务描述"                 # 干完退出
bun src/cli.ts -p "后续指令" --continue       # 续最近会话
bun src/cli.ts -p "后续指令" --session <id>   # 续指定会话（并行任务不串线）
```

`-p` 模式与调用方双向沟通：危险命令确认、模型的 ask 提问会打一行
`@@ASK@@{...}` 到 stdout 并等 stdin 一行回复（没人接就当拒绝/不在线）。
结束时输出一行 `@@RESULT@@{outcome, filesChanged, committed, error, sessionId}`
结构化摘要——成果与事故分开呈现。退出码：0 = 有成果（包括干完活才翻车的
部分成功），1 = 颗粒无收。

## MCP 服务器（被 Claude Code 等指挥）

注册成全局 MCP 后，任何 MCP 客户端都能派活给 FoxAgent：

```bash
claude mcp add --scope user foxagent -- bun ~/Cli/src/mcp.ts
# 密钥三件套写进 ~/.claude.json 里 foxagent 的 env 字段，或用兜底文件
```

五个工具组成异步任务模型：`fox_submit`（提交立即返回 taskId；可带
`maxTokens` 设成本护栏，默认不限）→ `fox_wait`（挂起等待结果，零轮询；等满
timeoutSec 未完成则返回 running 续租信号，再调一次继续等；任务提问时立即
返回 question）或 `fox_status`（轮询增量输出；任务中断结束时带续跑指引）
→ `fox_reply`（回答提问，任务继续）；`fox_sessions`（列出项目的历史会话：
最近任务、最后回复摘要、轮数——新调用方先用它找回会话再续上，跨 session 无缝接力）。
任务表只在内存，MCP 服务器重启即失效。完整轨迹落在
`~/.foxagent/projects/<路径>/runs/<taskId>.log`（fox_status 任何状态都返回该路径，
怀疑假死直接 tail 它）。中断的任务用 `fox_submit` 传 `session=result.sessionId`
续跑，之前的分析上下文还在。

编译成单文件（不依赖 bun/node，拷走就能跑）：

```bash
bun run cli:compile        # 当前平台 → ./foxagent
bun run cli:compile:win    # 交叉编译 Windows → foxagent.exe
```

## 数据存储

所有数据集中在 `~/.foxagent/`，项目目录零污染：

```
~/.foxagent/
  FOXAGENT.md                              全局指示（跨项目，全文注入）
  projects/<项目路径>/
    sessions/<id>.json                     会话（含 thinking、journal 暂存）
    memory/MEMORY.md                       项目记忆索引（注入）
    memory/<slug>.md                       每条记忆一个文件（按需读）
    journal.md                             工作档案（全文注入）
    runs/<taskId>.log                      MCP 任务的完整轨迹
```

交互 CLI 和 -p/MCP 读写同一份会话——终端开的工，派任务续会话接着干。

## 上下文压缩

每轮请求前估算用量，超过窗口 90% 时触发（对齐 CC 的 auto-compact——压缩有损，
原始细节尽量多留，上下文缓存已摊薄长历史的重复成本）。趁历史完整（工具输出不预裁剪）
让模型做一次全量总结，替换前段原文。压缩会使该轮接口缓存失效（已知代价），
窗口越大、压缩越少、缓存越好——这是 `[1m]` 约定存在的原因；
想要早压缩（强制提炼）就用不带 `[1m]` 的模型名。

## 记忆

- **全局指示** `~/.foxagent/FOXAGENT.md`：跨项目的偏好和要求，全文注入每次会话
- **项目记忆** `~/.foxagent/projects/<路径>/memory/`：每条一个 md 文件（带
  name/description/type 元数据头），`MEMORY.md` 是索引。新会话只注入索引，
  详情按 description 判断相关后自己读。写前查重更新，过时会删。全部纯文本可手改

## 工作档案

每个**任务**（不是每轮对话）结束后由代码自动追加到 `journal.md`：
时间、任务、改动（同文件合并计数）、命令（限量）、坑（失败操作+错误信息）、
结果。成功 `git commit` 或会话切换/退出时落盘。新会话全文注入。

## 收尾沉淀

任务中踩过坑时（编辑失败、命令非零退出），代码自动追加一次收尾请求：
坑清单递给模型判断是否值得存进项目记忆。收尾对话不进正式会话历史。

## 安全

- 路径锁定在工作区 + `~/.foxagent/`，重定向也必须过白名单
- 工具参数 shell 转义防注入
- 危险命令分级拦截（rm/sudo/git push 等），清单在 `tools.ts` 可调
- edit 的行号污染检测（模型把显示用的行号前缀抄进替换内容时自动报错纠正）
- 会话原子写（临时文件+rename），单文件损坏不影响其他会话
- 终端输出 ANSI 净化（防模型返回控制序列操纵终端）
- `-p` 模式危险命令走 `@@ASK@@` 哨兵问调用方，回 y 才执行；没人接（stdin 已关）视为拒绝

## 提示词

默认提示词在 `src/prompt.ts`。被操作项目根目录放 `system-prompt.md` 可覆盖——
调教不用改代码，改完开个新会话生效。

## 开发

```bash
bun install      # 装依赖
bun run check    # 类型检查（无构建步骤，bun 直接跑 ts）
bun run cli      # 在当前目录跑 CLI
```

改完必跑 `bun run check`，再用 `-p` 模式冒烟一次。
设计决策在 `docs/decisions.md`，架构在 `docs/architecture.md`。
