# Skill Name And Turn State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模型只用 `SKILL.md.name` 激活 Skill，并把 Turn 改造成有明确活动阶段、合法转换和原子终态持久化的分层状态机。

**Architecture:** Skill Installation UUID 继续作为 Agent 绑定键，Registry 的内部键不暴露给模型；模型目录和 Tool Schema 只暴露唯一 `name`。Turn 使用顶层生命周期状态与活动阶段两层语义：`active` 表示尚未终止，`phase` 表示正在准备上下文、请求模型、执行工具、等待用户或收尾；Repository 是合法转换的唯一写入口，ACP/Web 只投影已持久化事实。

**Tech Stack:** TypeScript 7、ACP SDK 1.3、React/Zustand、Vitest、原子 JSON Store

---

## File Structure

- `apps/remote/src/skills/skill-tool-provider.ts`: 模型侧以 Skill name 调用渐进加载工具。
- `apps/remote/src/skills/skill-registry.ts`: 在已安装 Skill 中完成严格 name 查询，不做前缀或别名兼容。
- `apps/remote/src/conversation/context-assembler.ts`: Skill 目录只披露 name、description、trust。
- `apps/remote/src/repository/turn-state-machine.ts`: Turn 生命周期、活动阶段和合法转换的纯领域函数。
- `apps/remote/src/repository/session-types.ts`: 持久 Turn 事实使用 `active + phase` 与互斥终态。
- `apps/remote/src/repository/session-repository.ts`: 集中执行状态转换、运行中检查点和“输出+终态”原子提交。
- `apps/remote/src/runtime/agent-runtime.ts`: 在真实模型/工具边界发出阶段事实，并对模型工具循环设置显式资源上限。
- `apps/remote/src/acp/kindergarten-agent.ts`: 先持久化阶段再发 ACP 投影；最终一次事务提交输出和终态。
- `packages/contracts/src/turn-state.ts`: Remote/Web 共用的 Turn 投影契约与 ACP 通知解析。
- `apps/web/src/prompt-turn/*`: 生命周期 `status` 与执行 `phase` 分离，不再把等待用户和运行混成同一枚举。
- `apps/web/src/acp/acp-client.ts`、`apps/web/src/App.tsx`: 接收 Remote 的 Turn 事实并归约当前 UI。
- `docs/ARCHITECTURE.md`、`docs/TECHNICAL_PLAN.md`、`docs/MCP_SKILLS.md`: 同步新标识和状态机边界。

### Task 1: Strict Skill Name Contract

- [x] 写失败测试：`activate_skill({name:"design-brief"})` 成功；`skill_id`、`skill:design-brief` 和未知 name 全部失败。
- [x] Registry 增加严格 name 查询；同名继续在初始化阶段拒绝。
- [x] Tool 参数改为 `name`，并把当前 Agent 可用名称写成 JSON Schema enum。
- [x] Context 目录移除内部 `id`，资源读取同样只接受 `name`。
- [x] 跑 Skill、Capability 与 Runtime capability refresh 测试。

### Task 2: Durable Hierarchical Turn State Machine

- [x] 为 `active` Turn 定义 `accepted -> preparing_context -> model_streaming <-> tool_execution -> finalizing`；用户阻塞是 `tool_execution` 下的 permission/input 计数投影。
- [x] 为 completed、failed、cancelled、interrupted 定义互斥终态；终态不得返回活动态，非法转换直接报错。
- [x] Repository 的 start/checkpoint/finish 全部通过状态机；启动恢复只把 `active` 收敛为 `interrupted`。
- [x] 增加 `checkpointTurnEntries` 与 `finishTurnWithEntries`：运行证据可阶段性落盘，最终输出和终态在同一 JSON 事务提交。
- [x] 写状态转换、终态不可逆、重启恢复和原子提交测试。

### Task 3: Runtime And ACP Phase Facts

- [x] Runtime 在上下文准备、每个模型轮次、工具批次和收尾边界报告 phase。
- [x] Permission/AskUser 等待开始与结束必须更新 blocker；并发等待使用计数聚合，不用单个布尔值猜测。
- [x] Tool start/finish 与每轮完成后 checkpoint 当前 Turn entries，避免等待授权时只有内存证据。
- [x] 增加可配置的最大模型轮次；达到上限以明确 `TURN_MODEL_ROUND_LIMIT` 失败，不伪装 completed 或永久 active。
- [x] ACP Adapter 在终态前进入 finalizing，并以 Repository 原子事务保存输出、usage、file references 和终态。

### Task 4: Web Projection

- [x] 自定义 ACP Turn 状态通知携带 Remote 已持久化的 `status/phase/waitingFor`。
- [x] Web reducer 使用 `{status:"active", phase}`，交互队列只是 waitingFor 的详细 UI 数据，不再承担服务端完成事实。
- [x] UI 分别显示准备上下文、模型生成、工具执行、等待授权、等待回答和收尾。
- [x] 断线/取消/失败只从 active 进入对应终态；旧 operation 的通知不得覆盖当前 Turn。

### Task 5: Validation And Current Data

- [x] 运行 Remote/Web 定向测试、全仓 `typecheck`、全仓 `test`、全仓 `build`。
- [x] 确认当前持久化数据没有遗留非法 active Turn；不在运行时代码中加入旧 `running` 或 `skill_id` 兼容分支。
- [x] 启动 Remote/Web，真实创建一轮 Skill 激活并检查 Control API 的 Turn 终态、phase 与输出证据。
- [x] 在页面检查活动文案、等待授权、取消和完成投影。

## Self-Review

- Skill model contract、Installation UUID 和 Registry 内部键职责互不混用。
- Turn lifecycle、active phase、用户交互 blocker、长任务 job state 仍是不同领域概念。
- 所有终态由服务端持久事实决定；ACP Update 只负责及时展示。
- 没有 `skill_id` 别名、自动补 `skill:` 前缀、旧 `running` 解析或静默状态修复。
- 所有新协议行为都有 Remote 与 Web 测试。
