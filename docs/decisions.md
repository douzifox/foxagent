# 设计决策记录

每条都是用户拍板的，改动前先弄清当时的理由。按时间顺序。

1. **VS Code 插件 + CLI 双形态，共享同一核心**
   用户最初就要插件（Cline 替代品）；CLI 后补。核心（agent/tools/...)不 import vscode。

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

## 待办（pi 借鉴清单，按价值排序）

源码在需要时 clone badlogic/pi-mono，重点 packages/agent/src/harness/。

- [ ] edit 模糊匹配：智能引号/Unicode 空格横线归一化重试 + 教学式错误文案
- [ ] 压缩迭代式更新：二次压缩基于旧摘要更新（PRESERVE/ADD/UPDATE 规则）而非重写
- [ ] 溢出自愈：上下文溢出时删失败消息、压缩、自动重试一次（附 20+ 家 provider 的溢出报错正则表）
- [ ] 树状会话（append-only + parentId + leaf 指针）——等真需要「回到某步重试」再上
