# FoxAgent 🦊

自己的 coding agent。一套核心、两张皮：VS Code 插件 + 终端 CLI。
接任意 OpenAI 兼容接口（DeepSeek、各类网关、Ollama 的 /v1 端点）。
agent 自己搜代码、读文件、精确修改、跑命令；文件修改自动应用（diff 展示留痕），
只有危险命令（rm、git push、sudo…）才弹确认；会话自动落盘可续聊，
上下文快满自动压缩；两层 md 记忆（全局 + 项目，索引 + 子记忆）。

## 配置（只认环境变量，密钥不落文件）

```bash
# 必须（写进 ~/.zshrc 或 Windows 系统环境变量）
export FOXAGENT_HOST=https://api.deepseek.com   # 或你的网关 /v1 地址
export FOXAGENT_API_KEY=sk-xxx
export FOXAGENT_MODEL=deepseek-chat

# 可选
export FOXAGENT_NUM_CTX=65536      # 上下文压缩阈值，默认 65536
export FOXAGENT_TEMPERATURE=0.3
export FOXAGENT_MAX_ITERS=25
```

走 Ollama 的 `/v1` 端点时，上下文长度要在 Ollama 服务端配
（环境变量 `OLLAMA_CONTEXT_LENGTH`），客户端设不了。

## VS Code 插件

1. 用 VS Code 打开本目录，按 **F5**（自动构建并弹出插件调试窗口）
2. 在调试窗口里**打开一个项目文件夹**（agent 需要知道在哪干活）
3. 点左侧活动栏的狐狸图标，开聊
4. 面板重新打开时自动接上上次会话；顶栏 ＋ 号开新会话
5. 文件修改自动应用并在面板里展示红绿 diff；危险命令会弹窗确认

注意：Mac 上双击图标启动的 VS Code 读不到 shell 的环境变量，
请从终端用 `code` 命令启动（Windows 用系统环境变量则无此问题）。

## 终端 CLI

```bash
cd 你的项目
bun ~/Cli/src/cli.ts             # 默认继续该项目最近一次会话
bun ~/Cli/src/cli.ts --new       # 开新会话
# 会话内命令：/new /sessions /resume <id> /exit
# 干活时：Esc 打断当前轮（会话保留）；Ctrl+C 退出（自动保存）
# 干活时继续输入会排队，本轮结束后自动发送；按 ↑ 随时取回队列消息修改
# 非交互模式（供程序/CC 调用）：-p "任务描述"，--continue 续最近会话
```

编译成单文件（不依赖 bun/node，拷走就能跑）：

```bash
bun run cli:compile        # 当前平台 → ./foxagent
bun run cli:compile:win    # 交叉编译 Windows → foxagent.exe
```

## 会话

按项目目录隔离，集中存在 `~/.foxagent/projects/<项目路径>/sessions/`——
在哪个项目里干活就只看到哪个项目的会话，不污染项目、不会误提交进 git。
CLI 和插件读写同一份：终端开的工可以到编辑器里接着干。

## 上下文管理

每轮请求前估算用量，超过窗口七成时两级压缩：
先裁剪老的工具输出（大头），还不够就让模型把前段对话总结成备忘、原文丢弃。

## 记忆（两层）

- **全局指示** `~/.foxagent/FOXAGENT.md`：你写给它的跨项目指示（对标 CLAUDE.md），
  单文件、全文注入每次会话；让它「记住」跨项目的偏好时它会自己更新这个文件
- **项目记忆** `~/.foxagent/projects/<项目路径>/memory/`：每条记忆一个 md 文件
  （元数据头 name/description/type + 正文，feedback/project 类型带「为什么/怎么用」），
  目录内 `MEMORY.md` 是索引。新会话只注入索引，详情它按 description 判断后自己读；
  写前查重（更新而不是重复建），记错了会删

全部纯文本，随时可手改。工作区外只放行 `~/.foxagent/`；模型把记忆偷懒写成
相对路径 `memory/…` 时（工作区里并无该目录）会被自动重定向到正确位置。

## 收尾沉淀（踩坑轮才触发）

任务结束时如果这一轮踩过坑（编辑失败、命令非零退出），代码会自动追加一次
收尾请求，把坑清单点名递给模型：有跨任务价值的教训 → 存进项目记忆；
一次性失误 → 回复「无需记录」。收尾对话不进会话历史，不污染上下文和缓存。
任务内的连续性交接由上下文压缩负责，新会话不注入旧任务摘要。

## 工作档案（journal.md，全文注入）

每轮任务结束后由**代码自动**追加到 `~/.foxagent/projects/<项目路径>/journal.md`：
时间、任务、改动（同文件合并计数）、命令（限量）、坑（失败操作和错误信息）、
结果摘要，每条几行。新会话全文注入——开工前先知道这项目做过什么、踩过什么；
纯问答轮次不记。条目本身是聚合摘要，攒到觉得重了再加归档机制。

## 危险命令清单

普通命令直接执行；匹配 `tools.ts` 里 `DANGEROUS_PATTERNS` 的才要确认
（rm/del/Remove-Item、dd、git push / reset --hard / clean、sudo、kill、
下载脚本管道执行等）。想调整口味就改那个数组。

## 提示词

默认提示词在 `src/prompt.ts`。被操作项目根目录放 `system-prompt.md` 可覆盖——
调教不用改代码，改完开个新会话生效。它每犯一次蠢，就回去加一条规矩。

## 搜索筛选

search 工具支持：`path` 限定子目录、`glob` 按文件名过滤（如 `*.ts`）；
自动尊重 .gitignore；项目根放 `.foxagent/ignore`（gitignore 语法）可额外排除目录。

## 结构

```
src/
  agent.ts           核心循环：问模型 → 执行工具 → 回传 → 直到它开口说话
  tools.ts           六个工具：read / edit / write / list / search / run
  config.ts          环境变量配置（唯一配置来源）
  context.ts         上下文估算与两级压缩
  session.ts         会话持久化（按项目隔离，CLI 与插件共享）
  prompt.ts          系统提示词 + 两层记忆索引注入
  cli.ts             终端入口
  extension.ts       VS Code 入口：侧边栏面板、diff 展示、会话恢复
  webviewContent.ts  聊天界面（内联 HTML，跟随编辑器主题）
```

## 常用命令

```bash
bun install      # 装依赖
bun run build    # 打包插件到 dist/
bun run watch    # 监听改动自动打包
bun run check    # 类型检查
bun run cli      # 在当前目录跑 CLI
```
