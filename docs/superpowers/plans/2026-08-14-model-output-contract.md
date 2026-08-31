# Model Output Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 防止只有思考过程、空响应或被截断的模型输出被误判为成功，同时不增加任何自定义恢复循环。

**Architecture:** Runtime 在 Agent 原始系统提示后附加固定响应契约，并在每次模型流结束后集中判断结果。只有工具调用进入现有工具循环，只有非空正文完成 Turn；thinking-only、空响应和截断直接沿现有 `RunFailure` 链路失败。Ollama Adapter 只负责把原生 `done_reason=length` 映射为通用截断原因。

**Tech Stack:** TypeScript、ACP、Ollama Chat API、Vitest

---

### Task 1: 用测试固定 Runtime 输出契约

**Files:**
- Modify: `apps/remote/test/runtime.test.ts`

- [x] **Step 1: 增加系统提示契约测试**

使用捕获输入的测试 Provider，断言实际 `systemPrompt` 同时包含 Agent 原提示和以下语义：

```text
仍需执行操作时必须调用工具；任务结束时必须输出非空最终正文；thinking 不能替代二者。
```

- [x] **Step 2: 增加终止条件测试**

用确定性测试 Provider 分别产生工具调用、正常正文、thinking-only、全空、`length` 和拒绝正文，断言：

```ts
expect(toolCall).toEnterExistingToolLoop();
expect(finalText).toComplete();
await expect(thinkingOnly).rejects.toMatchObject({ code: "EMPTY_ASSISTANT_RESPONSE" });
await expect(empty).rejects.toMatchObject({ code: "EMPTY_ASSISTANT_RESPONSE" });
await expect(truncated).rejects.toMatchObject({ code: "MODEL_OUTPUT_TRUNCATED" });
expect(refusalText).toComplete();
```

- [x] **Step 3: 先运行定向测试并确认新断言失败**

Run: `pnpm --filter @kindergarten/remote test -- runtime.test.ts`

Expected: 新增契约和失败终止断言在实现前失败。

### Task 2: 实现最小 Runtime 判断

**Files:**
- Modify: `apps/remote/src/runtime/agent-runtime.ts`

- [x] **Step 1: 组合固定响应契约**

```ts
const systemPrompt = appendModelOutputContract(agentSystemPrompt);
```

契约只说明合法输出，不要求模型重试，不产生额外消息或模型请求。

- [x] **Step 2: 集中判断单轮模型结果**

```ts
const outcome = resolveModelResponse({ content, thinking, calls: modelCalls, reason });
```

判断顺序为取消、截断、工具调用、非空正文、thinking-only/空响应。截断和无有效输出抛出 `RunFailure`；工具调用继续原循环；正文完成 Turn。

- [x] **Step 3: 运行 Runtime 测试**

Run: `pnpm --filter @kindergarten/remote test -- runtime.test.ts`

Expected: PASS。

### Task 3: 保留 Ollama 原生截断事实

**Files:**
- Modify: `apps/remote/src/model/ollama-provider.ts`
- Modify: `apps/remote/test/ollama-provider.test.ts`

- [x] **Step 1: 增加 `done_reason` 映射测试**

构造 `done_reason: "length"` 的 Ollama 终止 Chunk，断言 Provider 发出：

```ts
{ type: "finish", reason: "length" }
```

- [x] **Step 2: 解析并映射原生原因**

`stop` 或缺省值映射为 `stop`，`length` 映射为 `length`；不增加其他仓库形态或 Provider 猜测逻辑。

- [x] **Step 3: 运行 Provider 测试**

Run: `pnpm --filter @kindergarten/remote test -- ollama-provider.test.ts`

Expected: PASS。

### Task 4: 回归验证

**Files:**
- Verify only

- [x] **Step 1: 运行 Remote 全部测试和类型检查**

Run: `pnpm --filter @kindergarten/remote test && pnpm --filter @kindergarten/remote typecheck`

Expected: PASS。

- [x] **Step 2: 运行全仓测试、类型检查和构建**

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected: PASS；若发现与本次无关的既有失败，记录原始失败与影响范围，不改写无关代码。

- [x] **Step 3: 保持工作区提交边界**

本次不自动提交。当前工作区已有大量用户未提交修改，只报告本次实际编辑的文件，避免把无关改动混入提交。
