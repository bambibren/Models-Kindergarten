# ADR 001：Demo 产品化边界

- 状态：Accepted
- 日期：2026-08-12
- 决策版本：D2P-1

## 背景

V1.6 已有一条可工作的 Browser → ACP → Remote → AgentRuntime → ModelProvider/ToolRuntime 主链，但 `/demo` 中的 Agent 管理、固定身份会话、Context Lab、实验对比和资源中心仍使用浏览器内写死数据。继续把这些状态保留在 Demo 会形成两套事实源，也无法解释一次真实 Turn 到底使用了哪些能力和上下文。

## 决策

D2P-1 在不改变 ACP 主链的前提下新增以下产品事实：

- Agent 是单一可变配置实体；普通保存按 Remote 单进程队列串行处理，后一次成功保存生效，不引入 ETag、版本、归档或 Session 迁移。
- Session 创建时固定绑定 ModelStudent 与 Agent；已有 Session 页面不提供改绑入口。
- Skill/MCP 的配置、安装、Agent 绑定、Runtime 可见和执行授权分层管理；Browser 不能通过 `session/new.mcpServers` 注入受管能力。
- 文件继续经过 `FileSandbox`，产品只暴露 Session-scoped opaque `FileReference`，用于文本、图片、PDF、HTML 等安全预览。
- Context Experiment 固定包含 2～3 个 lane。每个 rerun lane 创建 `purpose=experiment` 的正式 ACP Session 并执行正式 Prompt；它是领域协调器，不是 Workflow、DAG 或第二 Runtime。
- 实验评分固定为理解、规划、输出、执行四维等权。每次实验完成后调用当前 ModelStudent 生成持久化人工标注工作表：合并公共需求、提取逐 lane Workflow、对逐 lane 结果做完整分段；模型只出题，不能输出人工 verdict 或分数。前三维只来自人对该工作表的选择；执行维只由 Runtime metrics 的确定性公式计算。三类人工注释未完成时不产生总分、排名或 winner。

## 继续排除

- 模型入园及 `/model-admission` 路由；
- 小说真实创作与 Bearer Token 小说 MCP；
- 自动评分、Judge 或任何让模型填写 verdict/分数的调用；标注工作表生成不属于评分调用；
- Memory/RAG、多 Agent、Handoff、Workflow/DAG、Runtime Event Store；
- MCP 市场、自动升级、Tasks/Apps；Skill 依赖安装和脚本自动执行。

首页保留不可点击的小说创作启动卡片，用来表达调研中的产品方向，但它不触发路由、填充 Prompt 或后端调用。

## 不变量

- Browser 与 Remote 之间只使用官方 ACP；一个浏览器页面只有一个 ACP connection owner。
- `load` 完整回放；`resume` 默认零回放，携带当前 Turn 游标时只补齐断线增量；每个 Session 同时最多一个 Prompt。
- Remote 不保存 Web 投影，Web 不保存 Runtime 状态。
- MCP Tool 与 Skill Runtime Tool 只通过 `ToolRuntime` 执行。
- 文件 Tool 必须经过 `FileSandbox`；写入走 ACP permission，补充信息走 ACP elicitation。
- Secret 不进入浏览器状态、ACP、Session、Experiment、Trace、日志或 FileReference。

## 结果

原有 V1.6 聊天链路仍是唯一执行主链；新增 Control API 只管理领域资源、查询执行事实和协调长任务。权威需求与合同分别见：

- [Demo 到真实产品实施 TRD](../DEMO_TO_PRODUCTION_TRD.md)
- [Demo 需求与差距](../DEMO_TO_PRODUCTION_REQUIREMENTS_AND_GAPS.md)
- [领域与接口合同](../DEMO_TO_PRODUCTION_CONTRACTS.md)
- [实施计划](../superpowers/plans/2026-08-11-demo-to-production-implementation.md)
