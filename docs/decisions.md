# 设计决策记录

每条都是用户拍板的，改动前先弄清当时的理由。按时间顺序。

1. **VS Code 插件 + CLI 双形态，共享同一核心**
   用户最初就要插件（Cline 替代品）；CLI 后补。核心（agent/tools/...)不 import vscode。
   2026-08-13 修订：插件形态砍掉（见决策 20），入口改为 CLI + MCP 服务器。

2. **Bun + TypeScript**
   直接跑 TS、`bun build --compile` 交叉编译出 Windows 单文件。代码只用标准 node: 接口，保留退回 Node 的余地。

3. **只走 OpenAI 兼容接口，砍掉 Ollama 原生路径**
   终点是 DeepSeek；Ollama 的 /v1 端点也通。曾有双协议版本，用户拍板删掉。
   代价：num_ctx 客户端设不了，要在 Ollama 服务端配 OLLAMA_CONTEXT_LENGTH。

4. **配置只认环境变量**（FOXAGENT_HOST / API_KEY / MODEL + 可选项）
   VS Code 设置项全部删除，两端同一套配置。
   2026-08-04 修订：红线从「密钥不落任何文件」改为「密钥不进项目目录」——
   主目录下的配置可以落盘（~/.claude.json 的 MCP env 字段、~/.config/foxagent/env 兜底），
   「CC 的密钥也落盘，我不过是没用 API 模式而已」；进业务项目目录（会被 git/其他工具扫到）才是事故。

5. **自动批准 + 危险分级**
   「rm 这种才要确认，不然烦死了。」文件修改自动应用（diff 留痕，git 兜底）；
   只有 DANGEROUS_PATTERNS 命中的命令弹确认（删除类、git push/reset --hard/clean、
   sudo、kill、dd、curl|sh 等，Mac/Windows 删除命令都覆盖）。

6. **上下文压缩：全量总结一步到位，绝不预裁剪工具输出**
   「去掉的工具调用才是核心，就应该在全上下文的时候压缩。」
   曾有两级压缩（先裁旧工具输出再总结）——被否，裁剪毁掉的恰是总结的原料。

7. **记忆两层，结构不对称（刻意的）**
   - 全局 = 单文件 ~/.foxagent/FOXAGENT.md，「用户的全局指示」，全文注入。
     对标 CLAUDE.md；偏好每条都要时刻生效，不存在按需读取，索引制是过度设计。
   - 项目记忆 = 索引 + 每条一个文件（frontmatter：name/description/type），
     按 description 按需读。type 只有 feedback/project/reference（user 归全局）。
   - 都存 ~/.foxagent/projects/<路径>/ 下，项目目录零污染，不进 git。

8. **journal（工作档案）三原则**
   - 代码自动写，不靠模型自觉——确定性的事交给代码
   - 粒度是「任务」不是「轮次」：轮内累积到 session.pending，
     成功 git commit（任务完成的确定信号）或会话切换/退出时落盘一条
   - 核心价值是「坑」（失败操作+错误信息）；条目聚合限行数
   - 全文注入新会话（「开新会话全部注入也没关系」）；将来太大再加归档

9. **收尾轮：踩坑才触发**
   任务内交接靠压缩；跨任务有价值的是坑的教训 → pitfalls 非空时追加一次
   收尾请求让模型判断是否存项目记忆（「无需记录」是合法答案）。
   收尾对话用历史副本，不进正式会话（不脏缓存）。

10. **完成即收尾的家规**（验证→commit→汇报）
    写进提示词但 gemma4 不执行——保留等大模型。commit 检测机制已就位。

11. **打断与队列（对齐 CC 手感）**
    Esc 打断当前轮（AbortSignal），Ctrl+C 退出；干活时输入排队本轮结束自动发送，
    ↑ 取回队列消息修改（借 readline 原生历史召回，只需同步出队）。

12. **-p 非交互模式**（供 CC 等程序调用）
    同步进程、危险命令自动拒绝并汇报、退出码 0/1、--continue 续会话。
    协作模式：CC 出方案 → FoxAgent 执行 → CC 用 git diff 独立验收（不信汇报）。

13. **设计哲学（总纲）**
    轻量 + 高缓存命中（提示词短、前缀稳定）是竞争力；打磨顺手 > 功能堆砌；
    确定性交给代码，智能才交给模型；每次它犯蠢 = 加一条家规或一个机制。

14. **模型窗口标注约定 [1m]**
    模型名带 `[1m]` 后缀 = 1M 窗口，不带 = 200k（默认）。发给 API 前剥离标注。
    `FOXAGENT_NUM_CTX` 只覆盖默认值（200k），推断出 1M 时以推断值为准不受覆盖。
    这样用户接新模型不用手动查窗口。

15. **代码 review 驱动的安全修复**（2026-08-04，DeepSeek 审出）
    四批 review 共 32 条，30 条真实：
    - 路径逃逸（memory/ 重定向绕白名单）→ 重定向结果必须过 ensureWithin
    - shell 注入（search 的 path 参数未转义）→ 统一 shq 转义函数
    - 流式错误被吞（SSE error/finish_reason=length 静默完成）→ 上抛报错
    - journal 重复（Ctrl+C 没清 pending）→ flush 后置空
    - tool_call_id 不配对 → 非流式也补 fallback id
    - edit_file new_string undefined → 类型校验
    - 会话原子写（writeFileSync → tmp+rename）、逐文件容错、id 防碰撞
    - 配置 NaN/超范围报错、日期改本地时区、终端 ANSI 注入净化
    - extension 会话替换丢数据 → busy 保护 + 局部变量锁定
    - webview tool_result 回放错配 → 栈替代单变量

16. **任务预算从轮数改为累计 token**（2026-08-13，经 lvbc 协作 session 转达拍板）
    轮数是资源的粗糙代理——一轮批量 10 个工具调用和单调用成本差十倍，计量不公平。
    主预算 = 累计 prompt token（优先 API usage 真值，缺失退回字符估算，只计主循环），
    默认 = 实际生效窗口 × 5（换模型不用改配置）；80% 注入收敛提醒，耗尽走硬断前总结轮。
    maxIters 放宽到 500 只做防死循环兜底（低 token 死循环按预算烧不完）。
    上下文自动压缩（决策 6）不变——预算管累计成本，不管单次上下文大小。
    已知特性：预算是软上限——80% 提醒轮放行后，最后一轮可显著超支
    （lvbc 实测 40k 预算耗到 53594，超 34%；默认 1M/5M 下可忽略）。
    收紧方案（提醒后预测超 100% 则不发送直接进总结轮）已知，暂不做。
    2026-08-13 修订：默认预算改为不限，机制降级为可选护栏——见决策 21。
    实际窗口/预算在 CLI 启动行和 fox_submit 返回（tokenBudget）里露出，便于核对 [1m] 是否生效。

17. **压缩窗口不与模型窗口解耦（提议被否，2026-08-13）**
    曾实现「压缩窗口默认 200k、[1m] 只作预算基数」的解耦方案，小狐狸否决：
    「[1m] 的语义就是整套 1M 模式（含压缩窗口跟随），想要 200k 压缩，
    把模型名里的 [1m] 去掉就好了，不需要改代码。」——用现有开关组合能表达的配置，
    不加新代码复杂度。想要「早压缩 + 大预算」的组合：不带 [1m] 的模型名 +
    显式 FOXAGENT_MAX_TOKENS。
    （调查结论存档：[1m] 只是客户端标注，API 物理窗口不随它变，
    去掉标注没有「安全垫」损失；压缩本就在窗口 70% 触发，30% 余量是机制内置的。
    唯一联动：不带 [1m] 时默认预算 = 200k × 5 = 1M——小狐狸确认数值合理。）

18. **压缩水位 70% → 90%**（2026-08-13，经 lvbc 协作 session 转达拍板）
    对齐 CC 的 auto-compact：压缩是有损的，原始细节尽量多留；DeepSeek 的上下文缓存
    把长历史重复发送的成本摊薄（命中约一折价），晚压缩不再昂贵。
    压缩检查在每轮发送前执行、估算对象就是即将发送的完整 prompt，天然预测式，
    90% 水位不存在「单轮跳变直发超限」的窗口。
    配套：开流式 stream_options.include_usage，@@RESULT@@ 带 tokensSpent 与
    cacheHitRate（真值计量 + 命中率观测），以后调这类阈值有实测依据。

19. **删掉备用模型 FOXAGENT_FALLBACK_MODEL**（2026-08-13）
    「上游挂了备用一样挂」——备用模型走同一个 host，主力 503 时它也 503，伪冗余。
    上游故障的真实对策就是指数退避重试（已有）。chatWithRetry 退化为单模型重试。

20. **砍掉 VS Code 插件形态**（2026-08-13）
    「太难了，就让 fox 做（CC session 们的）小助手吧；ds 马上要出自己的 harness。」
    修订决策 1 的双形态：现在是终端 CLI + MCP 服务器两个入口。
    删除 extension.ts / webviewContent.ts / dist / media / .vscode 及 package.json
    插件字段与 esbuild 依赖；ToolIO/onEvent 的界面解耦保留（入口层依旧可插拔）。

21. **默认取消 token 预算上限**（2026-08-13，经 lvbc 协作 session 转达拍板）
    「他的累计额度就是我的钱，不需要。」——成本 owner 自担，默认限额反而把正常任务
    掐死。实例：定位型任务烧完默认 1M 预算被中断，而 cacheHitRate 0.913 说明
    名义消耗虚高、真实成本仅约 1/5。
    maxTokens / FOXAGENT_MAX_TOKENS 降级为可选护栏：显式设置时 80% 预测提醒 +
    耗尽硬断总结照旧生效；默认 Infinity 让比较天然永不触发（agent 层零改动）。
    防死循环靠 maxIters=500 兜底。tokensSpent/cacheHitRate 观测保留。
    「按缓存加权计量」不做——无默认预算后失去意义。修订决策 16 的「默认 = 窗口 × 5」。

## 待办（pi 借鉴清单，按价值排序）

源码在需要时 clone badlogic/pi-mono，重点 packages/agent/src/harness/。

- [ ] edit 模糊匹配：智能引号/Unicode 空格横线归一化重试 + 教学式错误文案
- [ ] 压缩迭代式更新：二次压缩基于旧摘要更新（PRESERVE/ADD/UPDATE 规则）而非重写
- [ ] 溢出自愈：上下文溢出时删失败消息、压缩、自动重试一次（附 20+ 家 provider 的溢出报错正则表）
- [ ] 树状会话（append-only + parentId + leaf 指针）——等真需要「回到某步重试」再上
