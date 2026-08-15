# Models Kindergarten D2P-1 架构

> D2P-1 保留 V1.6 的唯一 ACP/Runtime 主链，并将 Demo 中除小说和自动评分外的产品需求接入真实领域服务；模型入园开放 OpenAI 官方、自定义 Responses 与硅基流动 Chat Completions。边界决策见 [ADR 001](adr/001-demo-to-production-boundary.md)，完整目标见 [Demo 到真实产品实施 TRD](DEMO_TO_PRODUCTION_TRD.md)。

## 主链

```text
Browser React
  ⇅ ACP over WebSocket
ACP Agent Adapter
  → AgentRuntime
      → AgentRunner
          ⇄ ContextAssembler → modelMessages + ContextSegments
          ⇄ ModelProvider Catalog
              ├─ OllamaNativeAdapter
              ├─ ResponsesApiAdapter
              └─ ChatCompletionsAdapter
          ⇄ ToolRuntime
              ├─ RuntimeCapabilityCatalog
              │   ├─ ToolRegistry（内置）
              │   ├─ McpToolProvider
              │   └─ SkillToolProvider
              ├─ ToolCallLedger
              ├─ PermissionGate（执行策略）
              ├─ RetryExecutor
              └─ ToolExecutor → Sandboxes
          └─ RuntimeObservationSink
              → EvaluationTraceExporter → HTTP

Independent Evaluation Web
  ⇄ Remote Control API（Experiment/标注工作表/Scorecard）

Remote Control API
  → Agent / Skill / MCP / Session / Experiment / FileReference
  → 本地持久化与长任务协调

Evaluation Exporter
  → Independent Evaluation Service
      → Runtime Metrics
      → Turn Trace Repository
```

ACP Adapter 不实现模型循环或工具安全；Model Provider 不依赖 ACP；ToolRuntime 不依赖 Ollama；Chat Web 不保存 Runtime 状态。Evaluation 通过只读端口旁路观察主链，上传失败不能改变 Agent 结果。

## 单一事实源与投影

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

`SessionEntry` 保存 Message、Thought、Tool Call 及其结构化结果。需要私有连续性的 Provider 还会保存不参与聊天投影的通用 `provider_continuation` 信封；信封以 `modelStudentId + protocol + model + format` 绑定确切 Adapter，只有该 Adapter 解释 payload，公共 Repository 读取和 ACP replay 都会剥离它。Turn 执行中在 Context、Tool 与 Model round 边界增量 checkpoint，最终从 `finalizing` 把输出与互斥终态一次提交；临时文件写完后通过 rename 原子替换。Repository 写操作串行化并递增 Session revision。

```text
SessionEntry[] ──ChatProjector/ACP replay──► ChatEntry[]
       └────────ContextAssembler───────────► ModelMessage[]

Skill metadata ────────────────────────────► ContextSegment[]
MCP Resource ──────────────────────────────► ContextSegment[]
```

Thought 只用于聊天回放；Tool Call/Result 通过 `toolCallId` 恢复到历史模型上下文。Continuation correlation 用原始 Provider assistant/function-call payload 替换重复的可见投影，但保留对应 Tool Result；裁剪不会从同一原子组中间开始。通用 Context/Session 层只读取 correlation 与 payload 大小，不读取 Provider 私有结构。Context 原文披露与 Evaluation 只保存 opaque 占位，完整 payload 仅进入实际 Provider request。

Agent system prompt、Skills、MCP 和历史策略形成模型无关的语义上下文；切换 ModelStudent 不得改写这些内容。Provider Adapter 仍必须把同一份 `ModelInput` 投影为目标协议的请求格式，因此“上下文策略”与“模型适配层原文”是两个层次：后者可以因协议、Tool Schema 和原生推理参数而不同，但不能反向给 Agent 注入模型专属提示。Context Experiment 的 preview serializer 与 Token 统计精确性留待后续系统性重构，本轮只从实验策略中删除推理强度。

## AgentRuntime 与 AgentRunner

- `AgentRuntime`：聚合 Context、Runner、Tool 和可靠性能力；
- `AgentRunner`：执行一次 `session/prompt` 的模型—工具循环；
- `toRunFailure`：把无法继续执行的 Provider/Runtime 异常转换成 Prompt Turn 失败；
- 用户取消通过 AbortSignal 立即传播；模型不再调用 Tool 时，Prompt Turn 正常结束。

单个 Prompt Turn 不再设置模型请求轮次上限，Runtime 由模型正常结束、用户取消、Session close、Provider/Tool 致命错误或既有的小模型无效参数守卫收敛。Schema 参数错误始终以同一结构返回模型；只有 `ModelStudent.sizeClass=small` 时，启动入口才装配 `RepeatedInvalidToolCallGuard`：同一 Turn 的三个不同模型轮若提交工具名、参数名和参数值完全相同的无效调用（对象字段顺序忽略），第三次结束 Turn。同一模型轮的并行调用只计一次，不同参数分别计数。大模型不装配该节点，因此不会因这项策略被 Runtime 提前终止；本次没有修改该守卫。

Turn 生命周期是 `active | completed | failed | cancelled | interrupted`；只有 active 才携带 `accepted | preparing_context | model_streaming | tool_execution | finalizing` 阶段。等待授权和等待回答是 `tool_execution` 下的并发计数，不是另一组生命周期状态。Repository 是唯一状态转换入口，ACP/Web 只投影已经持久化的事实；实时通知失败不会阻止终态提交。

## Model reasoning policy

推理强度沿用同一 ACP/Runtime 主链，不引入第二套 Runtime 可视化或消息协议：

```text
ModelStudent reasoning capability
  + generationDefaults.reasoningProfile
            ↓
Session reasoningOverride（可选）
            ↓ Turn 边界解析并冻结
ResolvedReasoningSnapshot
            ↓
Provider native request + Turn/model-round facts
```

产品层只使用 `auto | fast | balanced | deep | max`，优先级固定为 `Session override > ModelStudent default`。`auto` 的动态文案是“跟随模型默认 · {档位}”；ModelStudent 在 `generationDefaults.reasoningProfile` 保存用户选择的有效默认值，capability 继续保存体检原始事实。能力控制区分 `fixed | toggle | effort_levels | token_budget`；布尔模型在 UI 显示“关闭/开启思考”，不能伪装成多档 effort。ACP 以 category=`thought_level` 的 SessionConfigOption 承载会话唯一允许覆盖的模型执行配置；Prompt 活动中不可修改。OpenAI Responses 与硅基流动 Chat Completions 分别在入园时主动体检目标 Endpoint，并持久化协议中性的 `nativeByProfile`；Runtime 与 ACP 根据 Session 的 `modelStudentId` 解析确切 Provider 和控制。完整所有权、迁移和上线门禁见 [Model Reasoning Policy](REASONING_POLICY.md)。

## MCP 与 Agent Skills

Remote 是唯一 MCP Host，每个 Server 对应一个独立 Client。MCP 支持 stdio、Streamable HTTP 和 modern/legacy 自动协商；外部 Tool 适配为现有 PreparedToolCall/ToolOutcome 后统一进入 ToolRuntime。MCP Resource 只按当前 Agent 配置绑定，默认只注入元数据，需要时通过 `read_mcp_resource` 读取。Agent 独占 system prompt 和上下文/能力策略；ModelStudent 的 `generationDefaults` 独占 temperature 等模型默认参数。产品和内部领域模型都不引入 AgentVersion/AgentRevision；Session 只关联 `agentId`。

Skills 按 builtin、project、user 三个作用域发现。Runtime system prompt 带版本化且不含名单的稳定 Skill 使用协议；动态上下文只保留 `name/description/trust` 元数据。`activate_skill` 是保留的协议名称，实际职责是按 SKILL.md 的 `name` 加载完整 SKILL.md；随后才可通过 `read_skill_resource(name,path)` 按需读取 references/assets/scripts。Installation UUID 只作 Agent 绑定键，不暴露给模型；不接受 `skill_id`、`skill:` 前缀或别名兼容。当前不会自动执行 Skill 脚本。

D2P-1 在每个 Turn 和模型轮次解析当前 Agent 实际可用能力并保存 generation snapshot。`ensure_agent_skills` 只接受当前用户消息中明确出现的有效来源 URL；安装或复用并绑定当前 Agent 后，只返回安装事实。下一模型轮次从同一次解析原子更新 Tool Schema、能力快照和唯一一份动态 Skill 目录，模型再按稳定协议调用 `activate_skill` 渐进加载正文。完整设计见 [MCP 与 Agent Skills](MCP_SKILLS.md)。

## 可管理领域与实验

- Agent 是可变配置，Session 的 `modelStudentId + agentId` 创建后不可变；Agent 修改后下一 Turn 读取新配置，已完成 Turn 保留当时的 Agent snapshot；Session 唯一可保存的模型执行覆盖是具体 reasoning override；
- 删除 Agent 不删除 Session 历史或 Turn snapshot；该 Session 仍可 load/replay，但下一次 prompt 必须明确提示“Agent 已删除，不能继续对话”，不能恢复或创建替代 Agent；
- 普通聊天 Session 与实验 Session 使用相同 Repository 和 Runtime，普通列表默认隐藏 `purpose=experiment`；
- FileReference 是对 Session workspace 内文件的 opaque 引用，读取仍经过 FileSandbox 和 owner/Session 关联校验；
- Context Experiment 固定 2～3 lane，保存每 lane 的 Context/Capability/Runtime 事实；
- Context Experiment 本轮只从 lane policy 删除推理强度，其他实验 source-of-truth、History、preview、评分、worksheet 和快照流程延期重构；
- lane 完成后，当前 ModelStudent 只负责生成一次持久化的标注工作表（公共需求、逐 lane Workflow、逐 lane 原文分段）；
- Scorecard 只接受人对工作表的选择 + Runtime execution 公式，模型不会产生 verdict、分数、排名或 winner。

推理字段变更采用一次性切换：先把历史聊天 Session/Turn 完整归档，再清空活跃 Session/Turn Repository；Agent、ModelStudent、Skills、MCP 与 Secret 不在清空范围内。新 Runtime 不读取带 `agent_default` 或旧 Agent 推理字段的历史 Turn。

## ToolRuntime

```text
模型 Tool Call
  → Schema 校验
  → canonical args / dedupeKey
  → ToolCallLedger
  → Permission
  → Retry Policy
  → Tool Handler / Sandbox
  → ToolOutcome
  → modelMessages + ACP Tool Update
```

内置工具：

```text
list_files · read_file · write_file · run_command
web_search · web_fetch · ask_user
```

没有 `update_plan` 或任何 Plan 能力。

完全相同的 Tool 与规范化参数只执行一次。重复提议返回带 `previousStatus`、`previousOutput` 的 `duplicate_blocked` 结构，继续交给模型理解；Runtime 不使用一组任意阈值强制结束对话。权限拒绝和失败也遵循相同规则。

## 错误与交互

错误在 Model、Tool、Transport 等事实边界识别。Tool 局部错误保留在对应 ToolItem；无法继续的后端错误通过 `session/prompt` JSON-RPC 错误保留具体文案，Web 统一归约为 `PromptTurnState.failed`。完整边界和状态设计见 [错误与 Prompt Turn 状态设计](ERROR_HANDLING.md)。

## 权限与沙箱

- Remote 决定 Tool 权限策略；Web `InteractionPendingPanel` 渲染 ACP Permission；
- `write_file` 使用 `ask`，`run_command` 使用 `always_ask`；
- Elicitation 只用于 `ask_user`，不能代替权限；
- FileSandbox 限制 root、真实路径、符号链接与 256 KiB 文件；
- ProcessSandbox 只在 macOS `sandbox-exec` 下运行，cwd 在 root 内，限制写入 root、禁止网络、限制环境变量、超时和输出；其他平台明确拒绝而不静默降级；
- `web_fetch` 只允许公开 http/https，逐次验证重定向和 DNS，拒绝本机/私网地址并限制正文大小。

## Retry 与熔断

- Ollama 在尚未开始读取 Stream 前对瞬时连接、429、5xx 最多尝试三次；
- `web_search/web_fetch` 在 ToolRuntime 层对网络/超时使用指数退避与 jitter；
- 写文件、终端、校验错误和权限拒绝不重试；
- Ollama 与各 HTTP Origin 使用进程内 closed/open/half-open 熔断；
- 同一依赖只有一个重试层，不跨 Tool Loop 重放副作用。

## Web 投影

`historyChatEntries` 与 `streamingChatEntries` 都使用 `order + byId`。Tool 完成顺序只更新对应 ID，不移动首次出现位置。正常连接由 PromptResponse 合并为历史；断线恢复由 Remote 返回的权威 Turn 终态提交。Reasoning/Tool disclosure 继续由局部组件状态管理。WebSocket 意外断开不取消 Runtime，Web 不自动重连；用户点击既有按钮后用当前 Turn 游标 resume。停止只 cancel 当前 Turn，正常路由离开和可监听到的页面关闭 close Session。
