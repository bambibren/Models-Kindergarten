# Complete Token Usage Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不引入 Runtime 可视化的前提下，为每轮聊天增加就近的输入/输出 token 分项估算，并在会话底部展示 Provider 返回的精确输入、输出总量。

**Architecture:** Model Provider 继续只产生 provider-neutral usage；AgentRuntime 按模型请求轮次累计精确 usage；ACP Adapter 在 Turn 结束时生成一次不可见的 token usage 事实并持久化、通知、回放。Web reducer 把 usage 归约到目标 ChatEntry，同时保留每 Turn 精确 usage 用于会话汇总；React 组件只消费已归约数据，不解释 Raw ACP。

**Tech Stack:** TypeScript 7、ACP SDK 1.3、React 19、Zustand、Vitest、Ollama `/api/chat` streaming。

---

## File map

- `apps/remote/src/model/model-provider.ts`: provider-neutral 精确 usage 类型。
- `apps/remote/src/model/ollama-provider.ts`: Ollama 最终 chunk 到 usage 的映射。
- `apps/remote/src/runtime/agent-runtime.ts`: 多模型轮次 usage 累计并随 `RunResult` 返回。
- `packages/contracts/src/index.ts`: token usage ACP 自定义通知与边界解析。
- `apps/remote/src/repository/session-types.ts`: token usage Session 事实。
- `apps/remote/src/acp/acp-output.ts`: 唯一 ACP 通知发送口。
- `apps/remote/src/acp/kindergarten-agent.ts`: Turn 终态分项估算、持久化和 load 回放。
- `apps/web/src/acp/acp-client.ts`: 自定义通知注册。
- `apps/web/src/chat/chat-types.ts`: UI 已归约 token 字段与不可见 usage entry。
- `apps/web/src/chat/chat-reducer.ts`: 通知归约、目标 Entry patch、Turn usage 保存。
- `apps/web/src/chat/chat-blocks.ts`: 不把 usage entry 渲染成消息块。
- `apps/web/src/components/chat/MessageEntryView.tsx`: 用户输入与回答就近标注。
- `apps/web/src/components/activity/ReasoningItem.tsx`: 推理分项就近标注。
- `apps/web/src/components/tools/ToolItem.tsx`: 模型生成的工具调用分项就近标注。
- `apps/web/src/components/chat/TokenUsageTotal.tsx`: 会话底部精确输入/输出汇总。
- `apps/web/src/components/chat/ChatViewport.tsx`: 放置无容器化的底部汇总行。
- `apps/web/src/styles.css`: 沿用暖灰聊天主题的小字样式。

### Task 1: 定义 usage 事实和精度语义

- [ ] 在 `model-provider.ts` 增加统一类型：

```ts
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}
```

- [ ] 在 `contracts` 增加 `TokenUsageNotification`。顶层 `inputTokens/outputTokens` 是 provider 精确值；`components[].estimatedTokens` 永远是估算值。

```ts
export interface TurnTokenUsage {
  schemaVersion: 1;
  turnId: string;
  modelRequests: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  components: TokenUsageComponent[];
}
```

- [ ] 为通知 parser 编写失败用例：缺少 `sessionId`、非法 category、负 token 值均拒绝。

### Task 2: 累计真实 Provider usage

- [ ] 在 Runtime 测试 Provider 中让两轮分别返回 usage，先断言新 `RunResult.usage` 不存在或不匹配。
- [ ] 在 `AgentRuntime.run()` 内按 round 保存最后一次 usage，并在 Turn 终态求和。
- [ ] 只对已报告字段求和；未报告的缓存/推理保持 `undefined`，不能伪装成零。
- [ ] Ollama 继续只填 `inputTokens/outputTokens`，因为官方 API 没有缓存和推理 token 明细。
- [ ] 运行 `pnpm --filter @kindergarten/remote test`，预期 Runtime usage 用例通过。

### Task 3: 生成、持久化和回放 Turn token usage

- [ ] 增加 `SessionTokenUsageEntry`，存储完整 `TurnTokenUsage`，但不得重新进入模型上下文。
- [ ] Turn 成功完成后，根据实际 SessionEntry 构建分项估算：

```ts
current_prompt = estimate(user.text)
reasoning = estimate(thought.text)
answer = estimate(assistant.text)
tool_call = estimate(JSON.stringify({ name, arguments: rawInput }))
```

- [ ] 工具执行结果不是模型输出，不记作 `tool_call` 输出；它只会在下一模型 round 中进入精确输入总量。
- [ ] 经 `AcpOutput` 发送 namespaced ACP custom notification，并把 usage entry 放在本 Turn SessionEntry 末尾。
- [ ] `load` 按历史顺序回放；`resume` 仍零回放。
- [ ] ACP 测试断言：Prompt 有 usage、Load 回放同一 usage、Resume 无通知、其他连接无串线。

### Task 4: Web 归约和统计

- [ ] 在 `ChatEntry` 中增加可选 `tokenEstimate`，并增加不可见的 `token_usage` entry。
- [ ] reducer 收到 usage 后，按 `messageId/thought messageId/toolCallId` patch 已有 Entry，保留首次出现顺序。
- [ ] usage entry 加入 streaming collection，Turn 完成时与其他 entries 一次性 commit。
- [ ] `selectEntryBlocks()` 跳过 usage entry，避免产生额外显示模块。
- [ ] 增加纯 selector：对 history + streaming usage entries 求和；缓存和推理仅作为子集明细，不参与重复加总。
- [ ] reducer 测试断言分项归位、多 Turn 总和、usage 不改变活动项顺序。

### Task 5: 就近标注与底部汇总

- [ ] 用户气泡右下方显示 `输入约 N tokens`。
- [ ] Assistant 回答末尾显示 `回答约 N tokens`。
- [ ] Thought trigger 显示 `推理约 N tokens`。
- [ ] Tool trigger 显示 `调用约 N tokens`；表示模型生成的工具名和参数，不包含工具结果。
- [ ] 会话底部添加单行文本 `本会话 · 输入 N tokens · 输出 N tokens`，无卡片、无背景、无独立统计面板。
- [ ] 所有分项使用“约”，底部 Provider 总量不使用“约”；缺少 provider usage 时不渲染总量。
- [ ] 窄屏隐藏非关键重复文案但保留数字，确保按钮标题不换行且无横向滚动。

### Task 6: 验证

- [ ] 运行 Web/Remote typecheck、tests、production builds。
- [ ] 重启现有服务并确认 Remote health 中仍为 `qwen3:8b`。
- [ ] 用真实对话验证无工具 Turn；检查用户、思考、回答、会话总量。
- [ ] 用真实工具 Turn 验证工具调用分项和多 round 输入累计。
- [ ] reload Session，确认 token usage 被持久化并原位恢复；切换 Session，确认汇总不串线。
- [ ] 浏览器检查 console、窄屏/桌面布局和旧 “Runtime 与评测” 入口仍不存在。

## Self-review

- Spec coverage: 气泡输入、推理/工具/回答输出分项、会话输入输出总量、缓存/推理子集语义均有对应任务。
- Type consistency: `ModelUsage` → `RunResult.usage` → `TurnTokenUsage` → `TokenUsageNotification` → Web `token_usage` entry 单向流动。
- Boundary check: 没有新增 SSE、Runtime UI、Web runtime store 或第二连接；仍为单 ACP connection owner。
- Accuracy check: 精确总量与估算分项在类型和文案上明确分离；未报告字段不以零冒充。
- Commit policy: 当前 worktree 含用户所有的未提交修改，本计划不自动创建 Git commit。
