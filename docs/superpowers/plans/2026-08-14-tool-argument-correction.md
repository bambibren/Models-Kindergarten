# Tool Argument Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有 Tool 参数错误由真实 JSON Schema 解释；只有服务端掌握唯一完整参数时才返回必须原样使用的 `exact_retry_arguments`，并阻止小模型无限纠错。

**Architecture:** 新增独立的 Tool Call 准备模块，在 Provider 准备完成后统一执行 JSON Schema 校验，并生成不猜测参数的 `schema_correction`。领域 Provider 可以显式返回 `argument_correction.exact_retry_arguments`；AgentRunner 给每个 Tool 一次纠错机会，第二次参数错误结束 Turn。

**Tech Stack:** TypeScript、Ajv、Vitest、现有 AgentRuntime/ToolRuntime。

---

### Task 1: 锁定两类错误输出

**Files:**
- Modify: `apps/remote/test/skills/skill-installation.test.ts`
- Modify: `apps/remote/test/runtime.test.ts`

- [ ] **Step 1: 修改权威参数测试**

断言安装 Tool 的参数错误包含：

```ts
expect(raw.argument_correction?.exact_retry_arguments).toEqual({
  source_urls: allowed,
  mode: "ensure",
});
expect(model.instruction).toContain(JSON.stringify({ source_urls: allowed, mode: "ensure" }));
expect(JSON.stringify(raw)).not.toContain("suggested_arguments");
```

- [ ] **Step 2: 增加普通 Schema 错误测试**

使用 `read_file` 的错误参数 `{ fileName: "a.txt" }`，断言：

```ts
expect(raw.validation_errors).toEqual(expect.arrayContaining([
  expect.objectContaining({ keyword: "required", parameter: "path" }),
  expect.objectContaining({ keyword: "additionalProperties", parameter: "fileName" }),
]));
expect(raw.schema_correction.expected_schema).toMatchObject({
  required: ["path"],
  additionalProperties: false,
});
expect(raw.argument_correction).toBeUndefined();
```

- [ ] **Step 3: 增加规范去重测试**

两个仅字段顺序不同的无效参数必须生成相同 `dedupeKey`：

```ts
expect(first.dedupeKey).toBe(second.dedupeKey);
```

- [ ] **Step 4: 运行失败测试**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/runtime.test.ts test/skills/skill-installation.test.ts`

Expected: FAIL，旧输出仍包含 `suggested_arguments`，且尚无统一 Schema correction。

### Task 2: 实现统一参数准备与错误结构

**Files:**
- Create: `apps/remote/src/tools/tool-call-preparer.ts`
- Modify: `apps/remote/src/tools/tool-registry.ts`
- Modify: `apps/remote/src/tools/tool-runtime.ts`
- Modify: `apps/remote/src/runtime/agent-runtime.ts`

- [ ] **Step 1: 定义纠错类型**

```ts
export interface ToolExactArgumentCorrection {
  message: string;
  exactRetryArguments: Record<string, unknown>;
}

export interface ToolSchemaCorrection {
  message: string;
  expectedSchema: ModelToolSchema;
}

export interface ToolValidationError {
  message: string;
  validationErrors?: ToolSchemaValidationError[];
  argumentCorrection?: ToolExactArgumentCorrection;
  schemaCorrection?: ToolSchemaCorrection;
  instruction?: string;
}
```

- [ ] **Step 2: 用 Ajv 校验真实 Schema**

`prepareToolCall()` 先调用原 Provider，再用对应 `ModelToolDefinition.function.parameters` 校验模型原始参数。Schema 失败时保留原始输入，生成：

```ts
validationError: {
  message: validationErrors.map((item) => item.message).join("；"),
  validationErrors,
  schemaCorrection: {
    message: schemaCorrectionMessage(schema),
    expectedSchema: structuredClone(schema),
  },
  instruction: "请删除所有未声明字段，仅按照 schema_correction.expected_schema 重新构造参数并重试一次。",
}
```

领域 Provider 已提供 `argumentCorrection` 时不得被通用 Schema 错误覆盖。

- [ ] **Step 3: 输出模型可读结构**

`ToolRuntime` 输出 snake_case：

```ts
argument_correction: {
  message: correction.message,
  exact_retry_arguments: correction.exactRetryArguments,
}

schema_correction: {
  message: correction.message,
  expected_schema: correction.expectedSchema,
}
```

- [ ] **Step 4: 统一调用准备入口**

`AgentRunner` 使用 `prepareToolCall()` 替换文件内的旧 `prepareCall()`；无效调用的去重键使用 `canonicalJson(call.arguments)`。

### Task 3: 修改 Skill 安装权威参数提示

**Files:**
- Modify: `apps/remote/src/skills/ensure-agent-skills-tool.ts`
- Modify: `apps/remote/test/skills/skill-installation.test.ts`

- [ ] **Step 1: 替换建议语义**

```ts
const exactRetryArguments = {
  source_urls: this.providedUrls,
  mode: this.allowedModes[0],
};

argumentCorrection: {
  message: "上面的调用没有执行。下一次调用必须原样使用 exact_retry_arguments，不得增加、删除、重命名或修改任何字段。",
  exactRetryArguments,
},
instruction: `请重新调用一次。正确的完整参数是：${canonicalJson(exactRetryArguments)}`,
```

- [ ] **Step 2: 运行专项测试**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/skills/skill-installation.test.ts`

Expected: 18 tests PASS。

### Task 4: 限制无效参数纠错次数

**Files:**
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/src/tools/tool-runtime.ts`
- Modify: `apps/remote/test/runtime.test.ts`

- [ ] **Step 1: 增加第二次失败终止测试**

Fixture 连续两轮给 `read_file` 传无效参数，断言：

```ts
await expect(runner.run(...)).rejects.toMatchObject({
  code: "TOOL_ARGUMENT_RETRY_LIMIT",
  retryable: false,
});
expect(observer.outcomes).toHaveLength(2);
```

- [ ] **Step 2: 实现每 Tool 一次纠错预算**

AgentRunner 记录每个 Tool 的 `invalid_arguments` 次数。第一次将 Schema 错误交回模型；第二次先保存 Tool outcome，再以 `TOOL_ARGUMENT_RETRY_LIMIT` 收敛 Turn。重复调用缓存必须保留前一次 `invalid_arguments` 错误事实，以便计入预算。

- [ ] **Step 3: 运行 Runtime 测试**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/runtime.test.ts`

Expected: PASS，且既有成功调用去重行为不变。

### Task 5: 全量验证

**Files:**
- Verify only

- [ ] **Step 1: 搜索旧名称**

Run: `rg -n "suggested_arguments|suggestedArguments|argument_hint|argumentHint" apps packages --glob '*.ts' --glob '*.tsx'`

Expected: 无结果。

- [ ] **Step 2: Remote 全量验证**

Run: `pnpm --filter @kindergarten/remote test && pnpm --filter @kindergarten/remote typecheck && pnpm --filter @kindergarten/remote build`

Expected: 全部通过。

- [ ] **Step 3: 全仓验证**

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected: 全部通过；仅允许既有前端大 chunk 警告。
