# Model Output Item 生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让思考、回答、模型工具请求和工具执行都有由 Remote 掌握的明确开始/增量/结束边界，彻底消除“工具参数已生成数分钟但 UI 仍显示正在思考”和“工具尚未执行却显示执行中”的错位。

**Architecture:** Provider Adapter 把各家流规范化成内部 `output_item_started → output_item_delta → output_item_completed`；Runtime 校验生命周期、聚合最终模型输出并区分“工具请求准备完成”和“ToolRuntime 真正开始执行”；ACP 投影继续只使用官方 message/thought chunk、`tool_call`、`tool_call_update`，不新增 Browser 协议或第二套事件总线。Web 不推断 Raw ACP，只把现有 `pending` 与 `in_progress` 显示成不同文案。

**Tech Stack:** TypeScript、Vitest、官方 ACP SDK、OpenAI Responses / Chat Completions 流、React

---

## 设计结论

用户提出的“思考、回答、工具调用都应有开始结束边界”是合理的，但工具必须拆成两层：

1. **模型输出项生命周期**：模型开始提出工具请求、持续生成参数、参数生成完成。
2. **工具执行生命周期**：请求已准备/排队（`pending`）、Handler 真正开始（`in_progress`）、结束（`completed` / `failed`）。

不能把“模型正在生成 29 KB 的 `write_file.content`”叫作“工具正在执行”，也不能继续把它挂在上一段 reasoning 上。正常时序应为：

```text
reasoning started
  reasoning delta...
reasoning completed
tool request started      -> ACP tool_call(status=pending) -> Web「准备中」
  arguments delta...      -> 仅 Remote 聚合和计量，不把大参数逐片推给 Web
tool request completed    -> ACP tool_call_update(rawInput/title, status=pending)
permission / queue
tool execution started    -> ACP tool_call_update(status=in_progress) -> Web「执行中」
tool execution completed  -> ACP tool_call_update(status=completed|failed)
```

## 参考实现判断

- **JoyCodeTeamStudio 当前页面**：`AssistantChunk` 只有 `message | thought`，没有 item 终态；`ChatView` 通过“最后一个 entry 的最后一个 chunk 是否为 thought”推断是否还在思考。工具一出现，顺序变化会让思考 UI 停止，因此当前现象看起来较好；但它仍是前端顺序启发式，不是可靠的生命周期合同。其 Java WebSocket Adapter 对工具另有 `running / complete / error` 状态，并能读取 `inputDelta` 做 Write/Edit 文件预览。可以借鉴工具阶段，但不应复制它的思考推断。
- **Codex（核对提交 `a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67`）**：协议层定义 `ItemStartedNotification`、item 专属 delta 和 `ItemCompletedNotification`；Core 把 `OutputItemAdded` 投影为 started，把 `OutputItemDone` 收敛为 completed。模型产出的 tool item 完成后，才交给 tool runtime 排队执行；Command/MCP 工具自身再维护执行状态。这个分层与本方案一致。

## 不做的事情

- 不在 Web 增加超时器、内容静默检测或“看到工具就强行关闭思考”的启发式。
- 不新增 SSE、`RunEvt`、EventBus、Workflow/DAG 或另一套 Browser envelope。
- 不让 UI 解释 Provider 原始事件，也不绕过 ACP。
- 不把可能很大的工具参数 delta 推送到 Browser；前端只需要尽早看到 pending 卡片和完成后的规范化 `rawInput`。
- 不为 Evaluation 页面做特例；它继续复用正式 Chat reducer 和组件。

## Task 1：冻结内部 Model Output Item 合同

**Files:**

- Modify: `apps/remote/src/model/model-provider.ts`
- Create: `apps/remote/test/model/model-output-item-contract.test.ts`

- [ ] 先写类型级/行为测试，固定三种 item 和三段生命周期；测试还应证明 `usage`、`provider_continuation`、`finish` 保持为 response 级事件。
- [ ] 把当前扁平的 `text_delta`、`thinking_delta`、一次性 `tool_calls` 改成内部 item 合同：

```ts
export type ModelOutputItemKind = "reasoning" | "message" | "tool_call";

export type ModelOutputItemStarted =
  | { id: string; kind: "reasoning" | "message" }
  | { id: string; kind: "tool_call"; callId: string; name?: string };

export type ModelOutputItemDelta =
  | { kind: "text"; text: string }
  | { kind: "tool_name"; text: string }
  | { kind: "tool_arguments"; text: string };

export type ModelOutputItemCompleted =
  | { id: string; kind: "reasoning" | "message"; text: string }
  | { id: string; kind: "tool_call"; call: ModelToolCall };

export type ModelEvent =
  | { type: "output_item_started"; item: ModelOutputItemStarted }
  | { type: "output_item_delta"; itemId: string; delta: ModelOutputItemDelta }
  | { type: "output_item_completed"; item: ModelOutputItemCompleted }
  | ({ type: "usage" } & ModelUsage)
  | { type: "provider_continuation"; continuation: ProviderOpaqueContinuation }
  | { type: "finish"; reason: "stop" | "length" | "cancelled" };
```

- [ ] 明确注释：`item.id` 是一次模型流内的 item 身份；`callId` 是 Provider 工具调用身份，两者不得混用。
- [ ] 运行测试，确认旧 Provider 因合同变化按预期编译失败，从而列全迁移面：

```bash
pnpm --filter @kindergarten/remote typecheck
```

Expected: 在 Task 2～4 完成前只出现旧 `ModelEvent` 生产者/消费者的穷尽性错误；不得用 `as` 或默认分支压掉。

- [ ] Commit:

```bash
git add apps/remote/src/model/model-provider.ts apps/remote/test/model/model-output-item-contract.test.ts
git commit -m "refactor(remote): define model output item lifecycle"
```

## Task 2：Responses Adapter 保留原生 item 边界

**Files:**

- Modify: `apps/remote/src/model/responses-api-provider.ts`
- Modify: `apps/remote/test/responses-api-provider.test.ts`
- Modify: `apps/remote/test/support/responses-mock-server.ts`

- [ ] 增加失败用例：reasoning、message、function call 的 `response.output_item.added` 必须各自产生 started；对应 delta 必须携带 `item_id`；`response.output_item.done` 必须产生 completed，且发生在 response `finish` 之前。
- [ ] 直接使用 Responses 的 `item.id` 作为 `item.id`，使用 `call_id` 作为 `callId`。`output_index` 只用于排序和异常诊断，不作为跨层身份。
- [ ] `response.output_text.delta`、reasoning delta、`response.function_call_arguments.delta` 分别投影为 item delta，不再丢弃 message/reasoning 的 item 身份。
- [ ] `response.output_item.done` 的完整 item 是终态权威值；function call 必须在这里解析完整 JSON 并生成 `ModelToolCall`。`response.function_call_arguments.done` 只用于补齐/校验，不得导致同一个 item 重复 completed。
- [ ] 对缺失 `added` 但 delta 带稳定 `item_id` 的兼容端点，可惰性补发一次 started；缺少稳定 item/call 身份时直接抛 `invalid_model_response`，不偷偷退回轮次级聚合。
- [ ] 运行：

```bash
pnpm --filter @kindergarten/remote test -- responses-api-provider.test.ts
```

Expected: reasoning/message/tool 的 started、delta、completed 顺序全部通过；重复 done 和缺失身份用例明确失败。

- [ ] Commit:

```bash
git add apps/remote/src/model/responses-api-provider.ts apps/remote/test/responses-api-provider.test.ts apps/remote/test/support/responses-mock-server.ts
git commit -m "refactor(remote): preserve responses item boundaries"
```

## Task 3：Chat Completions Adapter 合成 item 边界

**Files:**

- Modify: `apps/remote/src/model/chat-completions-provider.ts`
- Modify: `apps/remote/test/chat-completions-provider.test.ts`

- [ ] 写回归流：先返回 reasoning，再返回一句“开始编写网站”，随后分片返回 `write_file` 的大段 arguments。断言第一段 tool fragment 到达时 reasoning/message 已 completed，工具 item 已 started，而不是等 `[DONE]` 才出现。
- [ ] 为没有原生 output item 的协议实现流内 sequencer：reasoning/message 首个 delta 创建合成 ID；channel 从 reasoning 切到 message/tool 时关闭上一 item；已经关闭的 channel 后续再次出现时创建新 item，禁止重开旧 item。
- [ ] Tool call 继续按稳定 `index` 聚合；一旦得到稳定 `call.id` 就发 started。`name` 尚未完整时允许 started 使用可选 name，后续 name/arguments 均发 item delta。
- [ ] `[DONE]` 前按 index 顺序完成全部尚未完成的工具 item并解析 JSON；再发 response `finish`。冲突 ID、无效 JSON、finish reason 缺失仍保持 fail-fast。
- [ ] 增加至少 32 KB arguments 的测试，证明大量参数 delta 都被观测到，且不会增加 reasoning 文本或推迟其 completed。
- [ ] 运行：

```bash
pnpm --filter @kindergarten/remote test -- chat-completions-provider.test.ts
```

Expected: 大 arguments 用例的事件顺序为 message completed → tool started → 多个 tool_arguments delta → tool completed → finish。

- [ ] Commit:

```bash
git add apps/remote/src/model/chat-completions-provider.ts apps/remote/test/chat-completions-provider.test.ts
git commit -m "refactor(remote): synthesize chat completion item boundaries"
```

## Task 4：Ollama 兼容 Adapter 合成相同合同

**Files:**

- Modify: `apps/remote/src/model/ollama-provider.ts`
- Modify: `apps/remote/test/ollama-provider.test.ts`

- [ ] 用测试固定 thinking → text → toolCalls → done 的边界顺序。
- [ ] thinking/text 使用合成 item ID；channel 切换时完成上一 item。Ollama chunk 中已完整出现的 tool call 立即 started + completed，不伪造 arguments delta。
- [ ] `done` 时完成仍开放的文本 item，再发 usage 和 finish；历史迁移兼容行为保持不变。
- [ ] 运行：

```bash
pnpm --filter @kindergarten/remote test -- ollama-provider.test.ts
```

Expected: Ollama 已有序列化、usage 和工具回填测试不回归，新生命周期顺序通过。

- [ ] Commit:

```bash
git add apps/remote/src/model/ollama-provider.ts apps/remote/test/ollama-provider.test.ts
git commit -m "refactor(remote): normalize ollama output item lifecycle"
```

## Task 5：在 Runtime 建立生命周期状态机，而非继续堆条件分支

**Files:**

- Create: `apps/remote/src/runtime/model-output-lifecycle.ts`
- Create: `apps/remote/test/runtime/model-output-lifecycle.test.ts`
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/test/runtime.test.ts`
- Modify: `apps/remote/test/runtime-memory-budget.test.ts`

- [ ] 先写状态机测试：正常三段式、多 item 交错工具参数、重复 started、未知 item delta、completed 两次、completed 后 delta、finish 时仍有开放 item、取消/失败收口。
- [ ] 实现单职责 `ModelOutputLifecycle`：按 item ID 保存 kind、buffer、started/completed 状态和首次出现顺序；completed 快照覆盖 delta 拼接结果并做一致性/容量校验。
- [ ] 将正文、thinking、工具参数的字节预算移到对应 delta/终态入口，保证 29 KB 参数被计入 tool argument budget，而不是 text/thinking budget。
- [ ] 状态机对外只提供：

```ts
interface ModelOutputSnapshot {
  content: string;
  thinking: string;
  calls: ModelToolCall[];
}
```

并按完成顺序稳定汇总多 message/reasoning item；工具仍按 Provider 顺序执行。

- [ ] 把 `RunObserver.text/thought/roundComplete` 替换为 item 级回调：

```ts
modelOutputItemStarted?(round: number, item: ModelOutputItemStarted): Promise<void>;
modelOutputItemDelta?(round: number, itemId: string, delta: ModelOutputItemDelta): Promise<void>;
modelOutputItemCompleted?(round: number, item: ModelOutputItemCompleted): Promise<void>;
modelOutputItemsAborted?(round: number, reason: "failed" | "cancelled"): Promise<void>;
```

- [ ] `agent-runtime.ts` 每收到一个事件就先交状态机校验，再通知 observer；response `finish` 后从 snapshot 构造 `resolveModelResponse` 和下一轮 `ModelMessage`。
- [ ] Attempt 失败/取消时先调用 `modelOutputItemsAborted`，确保 UI 没有永久 streaming item；重试继续保留现有 message/thought reset 语义，并为新 attempt 使用新内部 item ID。
- [ ] `modelRoundCompleted` 只记录 round 事实，不再承担 UI item 结束语义。删除正常路径上的 `roundComplete`；终局清理只能作为异常兜底并产生可测试诊断。
- [ ] 更新所有 `RunObserver` fixtures，禁止保留空的旧 `roundComplete` 来假装兼容。
- [ ] 运行：

```bash
pnpm --filter @kindergarten/remote test -- runtime/model-output-lifecycle.test.ts runtime.test.ts runtime-memory-budget.test.ts
pnpm --filter @kindergarten/remote typecheck
```

Expected: Runtime 拒绝非法 item 顺序；失败、取消、重试都能关闭活动 item；类型检查无旧事件分支。

- [ ] Commit:

```bash
git add apps/remote/src/runtime/model-output-lifecycle.ts apps/remote/src/runtime/agent-runtime.ts apps/remote/test/runtime/model-output-lifecycle.test.ts apps/remote/test/runtime.test.ts apps/remote/test/runtime-memory-budget.test.ts
git commit -m "refactor(remote): own model output item lifecycle"
```

## Task 6：把 item 生命周期投影到现有 ACP，不新增 Browser 协议

**Files:**

- Modify: `apps/remote/src/acp/kindergarten-agent.ts`
- Modify: `apps/remote/test/acp-session.test.ts`
- Modify: `apps/remote/test/session/session-reasoning-acp.test.ts`

- [ ] 写端到端投影测试：reasoning delta 后收到 tool item started 时，先收到 reasoning 的 `_meta.final=true`，随后收到 `tool_call(status=pending)`；工具参数完成前不得出现 `in_progress`。
- [ ] 将 TurnProjection 的 message/thought 状态从仅按 round 保存，改为按 model item ID 保存，并保留 `{round, kind, ordinal}` 到稳定 Session messageId 的映射，以维持 retry reset 行为。
- [ ] message/reasoning 首个 delta 继续投影为 ACP chunk；item completed 时先 checkpoint 对应 Session entry，再立即发送空 chunk + `_meta.final=true`。零文本 item 不创建空 UI 卡片。
- [ ] tool item 获得稳定 `callId` 时创建同 ID 的 `SessionToolCallEntry` 与 ACP `tool_call`：`status="pending"`、`rawInput={}`、标题优先使用 name，否则“准备工具调用”。参数 delta 只在 Remote 聚合，不逐片投影到 Web。
- [ ] tool item completed 并经 `prepareToolCall` 后，用同一 `toolCallId` upsert：更新规范化 title/name/kind/rawInput/locations，状态仍为 `pending`。利用 Repository 现有 `tool:${toolCallId}` identity，避免生成第二张卡片。
- [ ] Attempt 失败、取消或连接终局清理时：活动 message/thought 发 final；尚未完成的 pending 工具更新为 failed。不得把未执行工具标成 completed。
- [ ] 将 `roundComplete` 改成仅断言当前 round 没有开放 item；测试中若正常路径触发兜底，应失败而不是静默修正。
- [ ] 运行：

```bash
pnpm --filter @kindergarten/remote test -- acp-session.test.ts session/session-reasoning-acp.test.ts
```

Expected: ACP 顺序与生命周期一致；load/resume 回放仍只有 Session 投影，不保存 Web 状态。

- [ ] Commit:

```bash
git add apps/remote/src/acp/kindergarten-agent.ts apps/remote/test/acp-session.test.ts apps/remote/test/session/session-reasoning-acp.test.ts
git commit -m "fix(remote): project item boundaries through acp"
```

## Task 7：区分 pending 与真正的工具执行开始

**Files:**

- Modify: `apps/remote/src/tools/tool-runtime.ts`
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/src/acp/kindergarten-agent.ts`
- Modify: `apps/remote/test/tool-loop.test.ts`
- Modify: `apps/remote/test/runtime.test.ts`

- [ ] 将 Observer 语义明确为 `toolPrepared`、`toolExecutionStarted`、`toolFinish`。`toolPrepared` 由模型 tool item completed 后调用；`toolExecutionStarted` 只允许 ToolRuntime 调用。
- [ ] 删除 `executeBatch` 开头批量调用 `toolStart` 的逻辑。授权通过且 Schema 有效后、调用 `registry.execute` 的前一行才触发 `toolExecutionStarted`：

```ts
const allowed = await this.permissions.authorize(call, observer);
if (!allowed) return deniedOutcome(...);

await observer.toolExecutionStarted(call);
return this.registry.execute(call, { askUser, signal });
```

- [ ] TurnProjection 在 `toolPrepared` 时仍发 `pending` 更新；在 `toolExecutionStarted` 时发 `in_progress`；finish 发 `completed/failed`。
- [ ] 把现有 `tool_call_started` execution trace 的时间点移动到真正执行开始。参数生成耗时属于 model attempt，不得混入工具执行耗时。
- [ ] 测试四条路径：正常 pending→in_progress→completed；权限等待期间保持 pending；拒绝 pending→failed 且从未 in_progress；参数校验失败 pending→failed 且 Handler 未运行。
- [ ] 运行：

```bash
pnpm --filter @kindergarten/remote test -- tool-loop.test.ts runtime.test.ts
```

Expected: 只有实际进入 Registry Handler 的调用出现 `in_progress` 和 execution-start trace。

- [ ] Commit:

```bash
git add apps/remote/src/tools/tool-runtime.ts apps/remote/src/runtime/agent-runtime.ts apps/remote/src/acp/kindergarten-agent.ts apps/remote/test/tool-loop.test.ts apps/remote/test/runtime.test.ts
git commit -m "fix(remote): separate tool preparation from execution"
```

## Task 8：Web 只做状态文案的最小修复

**Files:**

- Modify: `apps/web/src/components/tools/ToolItem.tsx`
- Modify: `apps/web/src/components/tools/ToolItem.test.tsx`
- Test only: `apps/web/src/chat/chat-reducer.test.ts`

- [ ] 不改 `ReasoningItem`、`chat-reducer`、`ChatBlockList` 和 Evaluation 页面；它们已经能消费 message final 和 ACP tool status。
- [ ] 将文案直接基于原始 status，而不是先压平成 `ActivityPhase`：

```ts
function phaseLabel(status: ToolCallEntry["status"]): string {
  if (status === "pending") return "准备中";
  if (status === "in_progress") return "执行中";
  if (status === "completed") return "完成";
  return "失败";
}
```

spinner 仍可让 pending/in_progress 共用，不引入新组件或新状态。

- [ ] 添加 SSR 组件测试，分别断言 pending 显示“准备中”、in_progress 显示“执行中”。
- [ ] 在 reducer 测试补一个只验证现有合同的回归序列：thought delta → thought final → tool pending，断言 thought 为 done、tool 为 pending；若测试已覆盖则只保留更明确的命名，不改生产 reducer。
- [ ] 运行：

```bash
pnpm --filter @kindergarten/web test -- components/tools/ToolItem.test.tsx chat/chat-reducer.test.ts
pnpm --filter @kindergarten/web typecheck
```

Expected: Web 生产代码只有工具状态文案的小改动；没有计时器、Raw ACP 分支或 Evaluation 特例。

- [ ] Commit:

```bash
git add apps/web/src/components/tools/ToolItem.tsx apps/web/src/components/tools/ToolItem.test.tsx apps/web/src/chat/chat-reducer.test.ts
git commit -m "fix(web): distinguish tool preparation from execution"
```

## Task 9：用真实故障形态做链路回归

**Files:**

- Create: `apps/remote/test/model-output-lifecycle-acp.test.ts`
- Modify only if fixture reuse is needed: `apps/remote/test/support/responses-mock-server.ts`

- [ ] 构造与故障一致的流：短 reasoning、短 assistant message、分成多帧并延迟到达的 29 KB `write_file.content`、快速真实 Handler、最终回答。
- [ ] 记录 ACP 通知顺序和时间戳，断言：

```text
reasoning final
  < tool pending
  < tool arguments completed / prepared update
  < tool in_progress
  < tool completed
  < final assistant message final
```

- [ ] 断言在参数生成窗口内：reasoning 已是 done；工具是 pending；Session 中同一 `toolCallId` 只有一个 entry；文件写入尚未发生。
- [ ] 断言 Handler 开始后才出现 in_progress，且文件写入仍经过 PermissionGate、ToolRuntime 和 FileSandbox。
- [ ] 断言断线 `resume` 从 Turn 游标只补增量，`load` 可回放已 checkpoint 的 pending/completed 工具，不产生重复卡片。
- [ ] 运行：

```bash
pnpm --filter @kindergarten/remote test -- model-output-lifecycle-acp.test.ts
```

Expected: 原故障在自动化测试中复现为正确的“已思考 + 工具准备中”，而不是“正在思考”或提前“执行中”。

- [ ] Commit:

```bash
git add apps/remote/test/model-output-lifecycle-acp.test.ts apps/remote/test/support/responses-mock-server.ts
git commit -m "test(remote): cover long tool argument lifecycle"
```

## Task 10：全量验证与代码审查门

**Files:**

- Verify: all modified files

- [ ] 搜索旧合同和错误文案，结果必须只剩迁移说明或历史 fixture：

```bash
rg -n 'text_delta|thinking_delta|type: "tool_calls"|roundComplete\(|toolStart\(' apps/remote/src apps/remote/test
rg -n 'pending.*执行中|status === "pending".*执行中' apps/web/src
```

- [ ] 运行 Remote/Web 定向测试、类型检查、全仓测试和构建：

```bash
pnpm --filter @kindergarten/remote test
pnpm --filter @kindergarten/web test
pnpm typecheck
pnpm test
pnpm build
```

Expected: 全部退出码为 0。

- [ ] 启动本地开发环境，在普通 Chat 与 Context Experiment 各跑一次长 HTML 生成，人工验收：思考及时结束；参数生成期间显示“准备中”；真正写文件时才显示“执行中”；最终卡片无重复且 load/resume 一致。
- [ ] Review placeholder scan：检查是否残留 TODO、FIXME、临时 generic tool 名、兼容分支或只为测试增加的导出；逐项删除或解释。
- [ ] Review type consistency：核对 Provider item ID、Provider call ID、Session `toolCallId`、ACP `toolCallId` 四者的映射；任何隐式互换都必须修正。
- [ ] Review architecture boundary：确认 Browser↔Remote 仍只有 ACP；Web 没有 Raw Provider 判断；工具执行仍只经 ToolRuntime/PermissionGate/FileSandbox；没有新增第二套事件 envelope。
- [ ] 最终提交：

```bash
git status --short
git diff --check
git log --oneline -10
```

Expected: 只有本方案范围内文件发生变化，`git diff --check` 无输出，每个提交可独立解释和回滚。

## 验收标准

- reasoning/message/tool request 的 started、delta、completed 由 Remote 产生和验证，前端不猜。
- reasoning 在模型切入 tool request 时立即结束，不等整个模型 response 完成。
- tool request 参数生成、权限等待、实际执行、终态四者不再混为同一“执行中”。
- 29 KB HTML 参数生成耗时归属模型 attempt；文件 Handler 耗时才归属工具执行。
- Web 仅改变 pending 文案并补测试；普通 Chat 与 Evaluation 使用同一投影链。
- ACP、Session load/resume、Provider continuation、工具安全边界和历史记录兼容不回归。
