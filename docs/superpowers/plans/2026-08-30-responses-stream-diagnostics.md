# Responses Stream Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不记录模型正文、工具参数、请求体或 Secret 的前提下，记录 Responses 原始 SSE 活动与内部 `ModelEvent` 投影关系，并复现 PPT Turn 以判定是上游真实静默还是 Adapter 隐藏了活跃 delta。

**Architecture:** 诊断只放在 Remote 的 Responses Adapter 边界，并由 `MK_RESPONSES_STREAM_DIAGNOSTICS=1` 显式开启。每条日志只包含请求关联 ID、事件类型、距前一事件时间、SSE/Delta 字节数和处理结果；正常运行默认零日志。复现使用现有 Web/ACP 主链，不绕过模型入园、ToolRuntime 或 Session。

**Tech Stack:** TypeScript、OpenAI Responses SSE、Vitest、pnpm、ACP

---

### Task 1: 增加脱敏的 Responses SSE 诊断

**Files:**
- Modify: `apps/remote/src/model/responses-api-provider.ts:1-330`
- Test: `apps/remote/test/responses-api-provider.test.ts`

- [ ] **Step 1: 写入失败测试，约束日志内容与默认关闭行为**

在 `apps/remote/test/responses-api-provider.test.ts` 增加两个测试：默认环境下消费包含 `response.function_call_arguments.delta` 的流时不写 `[responses-stream]`；开启 `MK_RESPONSES_STREAM_DIAGNOSTICS=1` 后，日志包含事件类型、`dataBytes`、`deltaBytes`、`gapMs`、`disposition: "buffered"`，且不包含 delta 原文、Bearer Token 或完整工具参数。

```ts
it("Responses 流诊断默认关闭，开启后只记录脱敏事件事实", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const secretDelta = "never-log-this-tool-argument";
  vi.stubEnv("MK_RESPONSES_STREAM_DIAGNOSTICS", "1");
  vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "write_file", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: secretDelta },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: `{\"content\":\"${secretDelta}\"}` },
    terminalResponseWithToolCall(),
  ])));

  await consume(makeProvider());

  const logs = warn.mock.calls
    .filter(([label]) => label === "[responses-stream]")
    .map(([, facts]) => JSON.parse(String(facts)) as Record<string, unknown>);
  expect(logs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "response.function_call_arguments.delta",
      disposition: "buffered",
      dataBytes: expect.any(Number),
      deltaBytes: Buffer.byteLength(secretDelta),
      gapMs: expect.any(Number),
    }),
  ]));
  expect(JSON.stringify(logs)).not.toContain(secretDelta);
});
```

- [ ] **Step 2: 运行目标测试并确认失败**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/responses-api-provider.test.ts`

Expected: FAIL，因为当前 Adapter 没有 `[responses-stream]` 诊断事实。

- [ ] **Step 3: 实现显式开关和脱敏事件事实**

在 `apps/remote/src/model/responses-api-provider.ts` 中为每次 `streamRequest` 建立不含 Session、Prompt 或 Secret 的关联 ID；仅在环境变量严格等于 `1` 时调用：

```ts
console.warn("[responses-stream]", JSON.stringify({
  requestId,
  at: new Date(now).toISOString(),
  elapsedMs: now - startedAt,
  gapMs: now - previousEventAt,
  type,
  dataBytes: Buffer.byteLength(message.data),
  deltaBytes: typeof event.delta === "string" ? Buffer.byteLength(event.delta) : 0,
  disposition,
}));
```

`disposition` 固定为 `yielded`、`buffered`、`ignored` 或 `terminal`；`response.function_call_arguments.delta` 标记为 `buffered`。禁止写入 `message.data`、`event.delta`、请求体、Base URL、Token、模型正文或工具参数。

- [ ] **Step 4: 运行目标测试和类型检查**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/responses-api-provider.test.ts`

Expected: PASS。

Run: `pnpm --filter @kindergarten/remote typecheck`

Expected: PASS。

### Task 2: 用现有主链复现并判定根因

**Files:**
- Runtime log only: `/private/tmp/models-kindergarten-responses-stream.log`
- Read-only evidence: `apps/remote/.data/sessions/*/turns/*.json`

- [ ] **Step 1: 用诊断开关重启本地 Remote**

先只停止属于当前仓库、监听 `127.0.0.1:7331` 的 Remote dev watcher 和子进程；保持 Web、Resource、Docker Preview 和其他仓库进程不变。随后运行：

```bash
MK_RESPONSES_STREAM_DIAGNOSTICS=1 pnpm --filter @kindergarten/remote dev > /private/tmp/models-kindergarten-responses-stream.log 2>&1 &
```

通过 `curl http://127.0.0.1:7331/health/live` 验证 Remote 恢复为 `200`。

- [ ] **Step 2: 通过 Web/ACP 复现同类 PPT 请求**

在 `http://127.0.0.1:5173` 新建绑定“大聪明”的 Session，提交原 PPT 请求；不直接调用 Provider，不绕过正式 Session、Agent、Skill 和 ToolRuntime。

- [ ] **Step 3: 对齐第四轮时间线并给出唯一分类**

只读取 `[responses-stream]` JSON 事实和新 Turn 的 `startedAt/completedAt/error/modelRounds`：

- 若 60 秒窗口内持续出现 `response.function_call_arguments.delta` 且 `gapMs < 60000`，确认 Adapter 隐藏活跃 delta 导致 Runtime 误判。
- 若任意相邻原始 SSE 事件 `gapMs >= 60000`，确认外部 `https://sub.deuo.top` 或其上游真的保持流静默。
- 若流明确以 `response.failed`、`error` 或提前 EOF 结束，按真实 Provider 错误归类，不归为空闲误判。

- [ ] **Step 4: 验证诊断无敏感内容并汇报**

搜索日志确认不包含请求 Prompt、工具参数正文、Credential Hint 或 Token；报告精确事件序列、最长 `gapMs`、失败发生层级和后续最小修复建议。本任务只定位，不修改 60 秒门禁语义。

### Task 3: 最终验证

**Files:**
- No additional files

- [ ] **Step 1: 运行相关回归测试**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/responses-api-provider.test.ts test/runtime.test.ts`

Expected: PASS。

- [ ] **Step 2: 运行仓库检查的低风险子集**

Run: `pnpm --filter @kindergarten/contracts typecheck && pnpm --filter @kindergarten/remote typecheck`

Expected: PASS。

- [ ] **Step 3: 提交前检查范围**

Run: `git diff -- apps/remote/src/model/responses-api-provider.ts apps/remote/test/responses-api-provider.test.ts docs/superpowers/plans/2026-08-30-responses-stream-diagnostics.md`

Expected: 只包含脱敏诊断、对应测试和本计划，不覆盖工作区现有的其他用户修改。
