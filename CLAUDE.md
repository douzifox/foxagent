# FoxAgent 开发指引

自制 coding agent，一套核心两张皮：终端 CLI（`src/cli.ts`）+ VS Code 插件（`src/extension.ts`）。
用户向说明见 README.md；本文件和 docs/ 是给开发者与 agent 看的。

## 常用命令

```bash
bun run check        # 类型检查（改完必跑）
bun run build        # 打包 VS Code 插件到 dist/（CLI 不需要构建，bun 直接跑 ts）
bun run cli          # 当前目录跑 CLI
bun src/cli.ts -p "任务"   # 非交互单任务（冒烟测试用这个）
```

测试方法：没有测试框架，用 `-p` 模式在临时目录跑真任务验证（需要环境变量
FOXAGENT_HOST / FOXAGENT_API_KEY / FOXAGENT_MODEL，见 README）。

## 地图

| 文件 | 职责 |
|---|---|
| src/agent.ts | 核心循环 runAgent + 模型调用 chatOnce（流式/非流式）+ 踩坑收尾轮 wrapUp |
| src/tools.ts | 六个工具 + 危险命令分级 + 路径安全（含记忆路径重定向、行号污染检测） |
| src/config.ts | 配置（只认环境变量，唯一来源）+ 模型名 [1m] 标注解析 |
| src/context.ts | 上下文估算与压缩（全量总结一步到位） |
| src/session.ts | 会话持久化（含 journal 暂存 pending） |
| src/journal.ts | 工作档案（任务粒度，代码自动写） |
| src/prompt.ts | 系统提示词组装 + 三块注入（全局指示/项目记忆索引/journal 全文） |
| src/paths.ts | ~/.foxagent/ 数据布局的唯一定义 |
| src/cli.ts | 终端入口（交互 + -p 非交互）；Esc 打断 / ↑ 取回队列 / Ctrl+C 退出 |
| src/extension.ts + webviewContent.ts | VS Code 入口与聊天面板 |

## 铁律（改代码前必读）

- **设计决策先读 docs/decisions.md**——每条都是用户拍板的，别自作主张推翻
- 架构与数据流细节见 docs/architecture.md
- 配置永远走环境变量，密钥绝不落任何文件（包括测试代码）
- 内部消息统一 Ollama 风格（arguments 是对象），发送时才转 OpenAI 格式
- 改完跑 `bun run check && bun run build`，再用 -p 模式冒烟一次
- 提示词改动要实测：gemma4:26b 对复杂新规矩服从性差，写完必须验证它真的执行
