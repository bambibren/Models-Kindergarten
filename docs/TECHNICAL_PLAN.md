# Models Kindergarten 技术方案与演进路线

> 当前实现基线：V1.5 Conventional Single-Agent Runtime
> 当前目标：打通常规 Agent Runtime 的最小完整功能链路，不以复杂算法优化模型效果。

## 1. V1.5 产品边界

```text
User → React Chat → ACP Client ⇄ Remote ACP Agent
                                   └→ AgentRuntime
                                       ├→ AgentRunner
                                       ├→ Ollama qwen3:8b
                                       ├→ ToolRuntime
                                       ├→ Session Repository
                                       └→ Observation Port → Evaluation Exporter

Evaluation Web ⇄ Evaluation Service ⇄ Turn Trace Repository
```

V1.5 是单用户、单 Agent、本地模型实验作品。Browser 与 Remote 只使用 ACP；不增加 Java/RCS、SSE、EventBus 或第二套 Runtime Event 协议。

## 2. 核心模块

| 模块 | V1.5 职责 |
| --- | --- |
| ACP Adapter | Session lifecycle、Prompt、流式 Update、Permission、Elicitation |
| AgentRuntime | 聚合 Runner、Context、Tool 和可靠性能力 |
| AgentRunner | 驱动一次 Prompt 的模型—工具循环并确定性停止 |
| ContextBuilder | `sessionEntries → modelMessages`，保留多轮消息与 Tool Result |
| ConversationRepository | V3 SessionEntry 事实、revision、串行原子写入和旧数据迁移 |
| ToolRuntime | 注册、校验、权限、精确去重、局部重试、执行和 ToolOutcome |
| ModelProvider | 与 ACP 解耦；当前实现 Ollama，保留 API Adapter 接口 |
| Resilience | 有限重试、指数退避、jitter、外部依赖熔断 |
| Web Chat Projection | ACP Update 归约为历史/流式 ChatEntry，按 ID 原位更新 |
| Runtime Observation Port | 只读发布本轮执行事实，不依赖 HTTP、存储或评测规则 |
| Evaluation Service | 独立进程接收终态 Trace、计算最小客观指标并持久化 |
| Evaluation Web | 独立页面按 Session/Turn 查询并展示执行树与评分结果 |

## 3. 数据设计

```text
事实数据层
├── sessionEntries
└── streamingSessionEntries

UI 投影层
├── historyChatEntries
├── streamingChatEntries
└── chatEntries

模型上下文层
└── modelMessages
```

一份 SessionEntry 事实同时产生 UI 和模型上下文投影，避免双写。Thought 不进入模型；Tool Call 与结构化 ToolOutcome 使用 `toolCallId` 关联并可以在后续 Prompt 恢复。

## 4. Runtime 循环与去重

Runtime 不再使用模型次数、Tool 次数、运行时长或连续失败数等通用预算强制结束 Prompt Turn。用户取消通过 AbortSignal 立即停止；模型不再提出 Tool 时，以模型 finish reason 完成。

ToolCallLedger 使用 `toolName + canonicalJson(arguments)` 作为精确 `dedupeKey`：首次调用执行；后续相同调用不重复产生副作用，而是把先前状态和输出结构化返回给模型。网络瞬时重试只发生在同一次 Tool/Provider 调用内部。

## 5. Tool 与策略

| Tool | 权限 | 自动重试 | 边界 |
| --- | --- | --- | --- |
| list_files | allow | 否 | FileSandbox |
| read_file | allow | 否 | FileSandbox |
| write_file | ask | 否 | FileSandbox + ACP Permission |
| run_command | always_ask | 否 | macOS ProcessSandbox + ACP Permission |
| web_search | allow | 网络瞬时错误 | 公开搜索页面、结果上限 |
| web_fetch | allow | 网络瞬时错误 | SSRF、重定向、类型与大小限制 |
| ask_user | Elicitation | 否 | ACP 表单 |

Plan 能力完全不做：没有 `update_plan`、PlanState、PlanStore、ACP Plan UI、Planner/Executor 或 Workflow/DAG。

## 6. Turn Evaluation 最小链路

AgentRunner 在关键执行边界向只读 Observation Port 发布事件。Exporter 按 `runId` 聚合终态 Trace，并异步通过 HTTP 发送给 Evaluation Service。Chat Web 只在 Turn 完成后生成带 `sessionId + turnId` 的导航链接，不读取评测数据。

Evaluation 当前只计算客观字段：完成状态、Model Round、Tool 调用与成败、重复调用、上下文与输出 Token、上下文截断、首 Token 延迟、总耗时、错误及权限违规。不包含 Dataset、Judge、总分和模型对比。

## 7. ACP 不变量

- 一个浏览器页面只有一个 ACP connection owner；
- 一个 Session 同时最多一个 Prompt；
- `load` 完整回放，`resume` 零回放；
- Handler 只向当前 AgentContext 输出，不跨 WebSocket 广播；
- Message、Thought、Tool 使用各自标准 ID；
- PromptResponse 是 Web 当前流式投影的整体提交边界；
- Permission 是安全授权，Elicitation 是信息补充。

## 7. 验收范围

- 多轮 user/assistant/tool 上下文；
- Tool Result 进入下一次模型调用并可从历史恢复；
- 多个 Tool 并行且 UI 顺序稳定；
- 成功、失败、拒绝后的重复调用不重复执行；
- 模型重复提议相同 Tool 时不重复执行副作用，并获得先前结构化结果；
- 终端每次询问、取消、超时、输出限制和沙箱边界；
- 网络搜索、网页读取、重试、熔断和私网拦截；
- Session V1/V2→V3 迁移、原子提交、Load/Resume；
- typecheck、test、build 和真实页面链路。

## 8. 后续演进

V1.5 之后按独立闭环选择，不默认一次全部进入：

| 阶段 | 候选能力 |
| --- | --- |
| V2 | Context 预算优化、总结压缩、来源追踪；Runtime Trace/可观测性 |
| V3 | Evaluation、Benchmark、失败分类和对比实验 |
| V4 | ModelStudent/AgentVersion 配置管理、课程与 Skill 绑定 |
| V5 | 长短期 Memory、检索、Revision、污染治理 |
| V6 | 多 Agent、Handoff、共享记忆和协作评测 |

当前明确不做：Runtime Timeline/Event Store、长期记忆、RAG、多 Agent、MCP 管理平台、云沙箱、容器调度、多租户、语义相似判重和自动模型降级。
