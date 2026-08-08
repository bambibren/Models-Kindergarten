# Models Kindergarten V1.5 架构

## 主链

```text
Browser React
  ⇅ ACP over WebSocket
ACP Agent Adapter
  → AgentRuntime
      → AgentRunner
          ⇄ ContextBuilder → modelMessages
          ⇄ ModelProvider → Ollama HTTP → qwen3:8b
          ⇄ ToolRuntime
              ├─ ToolRegistry
              ├─ ToolCallLedger
              ├─ PermissionGate（执行策略）
              ├─ RetryExecutor
              └─ ToolExecutor → Sandboxes
          └─ RuntimeObservationSink
              → EvaluationTraceExporter → HTTP

Independent Evaluation Web
  ⇄ Independent Evaluation Service
      → Minimal Evaluator
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

`SessionEntry` 保存 Message、Thought、Tool Call 及其结构化结果。Prompt 完成时，`streamingSessionEntries` 批量写入 V3 Repository；临时文件写完后通过 rename 原子替换。Repository 写操作串行化并递增 Session revision。

```text
SessionEntry[] ──ChatProjector/ACP replay──► ChatEntry[]
       └────────ContextBuilder────────────► ModelMessage[]
```

Thought 只用于聊天回放；Tool Call/Result 通过 `toolCallId` 恢复到历史模型上下文。裁剪不会从一组 Tool Result 中间开始。

## AgentRuntime 与 AgentRunner

- `AgentRuntime`：聚合 Context、Runner、Tool 和可靠性能力；
- `AgentRunner`：执行一次 `session/prompt` 的模型—工具循环；
- `toRunFailure`：把无法继续执行的 Provider/Runtime 异常转换成 Prompt Turn 失败；
- 用户取消通过 AbortSignal 立即传播；模型不再调用 Tool 时，Prompt Turn 正常结束。

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

`historyChatEntries` 与 `streamingChatEntries` 都使用 `order + byId`。Tool 完成顺序只更新对应 ID，不移动首次出现位置。PromptResponse 到达后合并为历史，Reasoning/Tool disclosure 继续由局部组件状态管理。
