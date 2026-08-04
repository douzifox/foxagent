# FoxAgent 🦊

自己的 coding agent。一套核心、两张皮：VS Code 插件 + 终端 CLI。
接任意 OpenAI 兼容接口（DeepSeek、各类网关、Ollama 的 /v1 端点）。

- 六工具：搜代码、读文件、精确修改、新建文件、列目录、跑命令
- 文件修改自动应用（红绿 diff 留痕），只有危险命令才弹确认
- 流式输出（打字机式实时显示思考和回复）
- 会话自动落盘可续聊，上下文快满时全量总结压缩
- 两层记忆：全局指示 + 项目记忆（索引制，每条一个文件）
- 工作档案：任务粒度自动记录，踩的坑重点标注，全文注入新会话
- Esc 打断 / ↑ 取回队列 / Ctrl+C 退出 / `-p` 非交互模式

## 配置

只认环境变量，密钥不落任何文件。

```bash
# 必须（写进 ~/.zshrc 或 Windows 系统环境变量）
export FOXAGENT_HOST=https://api.deepseek.com   # 或你的网关 /v1 地址
export FOXAGENT_API_KEY=sk-xxx
export FOXAGENT_MODEL=deepseek-v4-flash          # 模型名，见下方窗口约定

# 可选
export FOXAGENT_NUM_CTX=120000     # 覆盖默认的压缩阈值（见下方说明）
export FOXAGENT_TEMPERATURE=0.3
export FOXAGENT_MAX_ITERS=25
```

### 模型窗口约定

模型名默认按 **200k** 窗口处理。1M 窗口的模型加 `[1m]` 后缀：

```bash
export FOXAGENT_MODEL=deepseek-v4-flash         # → 200k 窗口
export FOXAGENT_MODEL=deepseek-v4-flash[1m]     # → 1M 窗口
```

`[1m]` 在发给 API 前自动剥离，不影响请求。
`FOXAGENT_NUM_CTX` 只覆盖默认值（200k）——带 `[1m]` 推断出 1M 时，以 1M 为准。
压缩在窗口的 70% 处触发；窗口越大，压缩越晚，接口缓存命中越高。

## VS Code 插件

1. 用 VS Code 打开本目录，按 **F5**（自动构建并弹出插件调试窗口）
2. 在调试窗口里**打开一个项目文件夹**
3. 点左侧活动栏的狐狸图标，开聊
4. 面板重新打开时自动接上上次会话；顶栏 ＋ 号开新会话
5. 文件修改自动应用并在面板里展示红绿 diff；危险命令弹窗确认
6. 干活时发送按钮变成「停止」可打断；继续输入会排队

注意：Mac 上双击图标启动的 VS Code 读不到 shell 环境变量，
请从终端用 `code` 命令启动（Windows 用系统环境变量则无此问题）。

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
bun src/cli.ts -p "任务描述"            # 干完退出，退出码 0=成功 1=出错
bun src/cli.ts -p "后续指令" --continue  # 续最近会话
```

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
```

CLI 和插件读写同一份——终端开的工可以到编辑器里接着干。

## 上下文压缩

每轮请求前估算用量，超过窗口 70% 时触发。趁历史完整（工具输出不预裁剪）
让模型做一次全量总结，替换前段原文。压缩会使该轮接口缓存失效（已知代价），
所以窗口越大、压缩越少、缓存越好——这是 `[1m]` 约定存在的原因。

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
- `-p` 模式危险命令一律拒绝

## 提示词

默认提示词在 `src/prompt.ts`。被操作项目根目录放 `system-prompt.md` 可覆盖——
调教不用改代码，改完开个新会话生效。

## 开发

```bash
bun install      # 装依赖
bun run build    # 打包插件到 dist/
bun run watch    # 监听改动自动打包
bun run check    # 类型检查
bun run cli      # 在当前目录跑 CLI
```

改完必跑 `bun run check && bun run build`，再用 `-p` 模式冒烟一次。
设计决策在 `docs/decisions.md`，架构在 `docs/architecture.md`。
