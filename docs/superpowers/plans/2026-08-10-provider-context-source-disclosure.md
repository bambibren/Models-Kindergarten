# Provider Context Source Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让上下文提要中的每个模块都能独立展开，并展示当前 ModelStudent 的 Provider Adapter 实际序列化原文，同时继续排除当前用户气泡内容。

**Architecture:** Runtime 继续拥有上下文分组语义，新增 Provider-neutral 的 `ModelContextFragment` 输入和 Provider-specific 的 `ModelContextSerialization` 输出。Ollama Adapter 使用与 `/api/chat` 请求完全相同的 system/message/tool 转换函数生成展示原文；ACP 自定义通知与 Session 只传递已序列化的只读快照，Web 只做结构化折叠展示。

**Tech Stack:** TypeScript 7、React 19、Radix Collapsible、ACP SDK 1.3、Vitest 4、Ollama Chat API

---

### Task 1: 定义 Provider Adapter 的上下文序列化端口

**Files:**
- Modify: `apps/remote/src/model/model-provider.ts`
- Modify: `apps/remote/src/model/fixture-provider.ts`
- Test: `apps/remote/test/ollama-provider.test.ts`

- [ ] **Step 1: 写 Ollama 序列化失败测试**

```ts
expect(JSON.parse(provider.serializeContext({
  kind: "messages",
  messages: [{ role: "assistant", content: "", toolCalls: [{ name: "read_file", arguments: { path: "a.txt" } }] }],
}).value)).toEqual([{ role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a.txt" } } }] }]);
```

- [ ] **Step 2: 运行测试并确认接口尚不存在**

Run: `pnpm --filter @kindergarten/remote test -- ollama-provider.test.ts`

Expected: FAIL，提示 `serializeContext` 不存在。

- [ ] **Step 3: 增加精确的端口类型**

```ts
export type ModelContextFragment =
  | { kind: "system"; content: string }
  | { kind: "tools"; tools: ModelToolDefinition[] }
  | { kind: "messages"; messages: ModelMessage[] }
  | { kind: "omitted"; sourceIds: string[] };

export interface ModelContextSerialization {
  provider: ModelProviderKind | "fixture";
  model: string;
  format: "json" | "text";
  value: string;
}
```

并把 `serializeContext(fragment)` 设为 `ModelProvider` 必需方法；测试 Provider 明确实现，不允许产品代码静默降级。

- [ ] **Step 4: 运行类型检查确认所有 Provider 实现点已暴露**

Run: `pnpm --filter @kindergarten/remote typecheck`

Expected: FAIL，仅剩各 Provider 缺少 `serializeContext` 的错误。

### Task 2: 让 Ollama 展示与真实请求共用转换函数

**Files:**
- Modify: `apps/remote/src/model/ollama-provider.ts`
- Create: `apps/remote/test/ollama-provider.test.ts`

- [ ] **Step 1: 抽取真实请求构造器**

```ts
function toOllamaRequest(student: ModelStudent, input: ModelInput) {
  return {
    model: student.provider.model,
    stream: true,
    think: true,
    tools: input.tools,
    options: { temperature: student.agentConfig.temperature ?? 0.4 },
    messages: [toOllamaSystemMessage(student.agentConfig.systemPrompt), ...input.messages.map(toOllamaMessage)],
  };
}
```

- [ ] **Step 2: 实现按片段序列化**

System 输出单个 Ollama message JSON，Tools 输出 tools 数组 JSON，Messages 输出转换后的 messages 数组 JSON，Omitted 输出 `{ sent: false, sourceIds }`。全部使用两空格格式化 JSON。

- [ ] **Step 3: 验证请求 Body 与模块序列化一致**

Mock `fetch` 捕获 `/api/chat` body，断言 system、tools、messages 与 `serializeContext` 逐项相同，避免展示逻辑和发送逻辑漂移。

- [ ] **Step 4: 运行 Provider 测试**

Run: `pnpm --filter @kindergarten/remote test -- ollama-provider.test.ts`

Expected: PASS。

### Task 3: 扩展 ACP 合同并严格校验原文快照

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/index.test.ts`

- [ ] **Step 1: 写 raw 快照解析测试**

```ts
raw: {
  provider: "ollama",
  model: "qwen3:8b",
  format: "json",
  value: "{\n  \"role\": \"system\"\n}",
}
```

同时测试非法 `format`、空 provider/model/value 被拒绝。

- [ ] **Step 2: 增加 `ContextSummaryRaw`**

`ContextSummaryItem.raw?` 保持可选，以便旧 Session 回放；新生成条目由 Runtime 全量写入。

- [ ] **Step 3: 运行合同测试**

Run: `pnpm --filter @kindergarten/contracts test`

Expected: PASS。

### Task 4: 按上下文模块生成适配层原文

**Files:**
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/src/model/fixture-provider.ts`
- Modify: `apps/remote/test/runtime.test.ts`
- Modify: `apps/remote/test/tool-loop.test.ts`
- Modify: `apps/remote/test/acp-session.test.ts`

- [ ] **Step 1: 写 Runtime 分组测试**

断言新轮次的 system/tools 条目有 raw；第二轮 history raw 包含上一轮消息和工具结果，但整个 ContextSummary 不包含当前 prompt。

- [ ] **Step 2: 将 Provider 传入 `contextSummary`**

Runtime 通过 `built.messages[index]` 与 `built.observations[index]` 对齐选择 segment/history 原始消息，再调用 `model.serializeContext`；当前 `current_turn` 永远不进入任何 summary raw。

- [ ] **Step 3: 为裁剪历史提供诚实的未发送快照**

`truncated_history` 展示 Adapter 返回的 `{ sent: false, sourceIds }`，不伪装成已发送原文。

- [ ] **Step 4: 补齐确定性测试 Provider**

所有 fixture provider 显式实现 `serializeContext`，保持 `ModelProvider` 接口完整。

- [ ] **Step 5: 验证持久化与 ACP 生命周期**

Run: `pnpm --filter @kindergarten/remote test`

Expected: load 回放 raw，resume 仍为零回放，当前 prompt 不泄漏到 summary。

### Task 5: 实现二级折叠与浅色原文面板

**Files:**
- Modify: `apps/web/src/components/context/ContextSummaryEntryView.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 把每个条目改为 Radix Collapsible**

外层“上下文提要”不变；每一行独立控制 open/closed，标题、详情、信任、条目数和 token 保持在 trigger 上。

- [ ] **Step 2: 在行内展示适配信息和原文**

```tsx
<div className="context-summary-raw-meta">
  <span>{raw.provider}</span><span>{raw.model}</span><span>{raw.format.toUpperCase()}</span>
</div>
<pre>{raw.value}</pre>
```

旧 Session 没有 raw 时显示“该历史记录创建时尚未保存模型适配层原文”。

- [ ] **Step 3: 应用既有设计系统**

使用暖灰浅色、单层边界、最大高度滚动、键盘焦点和 reduced-motion；不使用黑色 Inspector、卡片套卡片或新入口。

- [ ] **Step 4: 运行 Web 类型检查与测试**

Run: `pnpm --filter @kindergarten/web typecheck && pnpm --filter @kindergarten/web test`

Expected: PASS。

### Task 6: 端到端验证真实 qwen3:8b

**Files:**
- Verify only: running services and browser UI

- [ ] **Step 1: 重启 Web、Remote 并确认 Ollama 健康**

确认 5174、7331、11434 可用，Remote 报告 `qwen3:8b`。

- [ ] **Step 2: 新建 Session 并发送两轮提示**

第一轮验证 system/tools；第二轮验证 session history 包含上一轮但不包含当前用户气泡文本。

- [ ] **Step 3: 验证交互和可访问性**

逐个展开/收起模块，确认面板可滚动、长 JSON 不溢出、键盘聚焦清晰、控制台无错误或警告。

- [ ] **Step 4: 刷新验证 Session 回放**

刷新后 raw 快照保持；切换 Session 不串数据。

- [ ] **Step 5: 运行完整相关构建**

Run: `pnpm --filter @kindergarten/contracts test && pnpm --filter @kindergarten/remote test && pnpm --filter @kindergarten/web test && pnpm --filter @kindergarten/remote build && pnpm --filter @kindergarten/web build`

Expected: 全部 PASS；若根工作区仍失败，只报告已有的 evaluation-web 独立脏改动问题。

