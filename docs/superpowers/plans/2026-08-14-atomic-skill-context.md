# Atomic Skill Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 当前环境未提供该子技能，因此由当前会话按相同步骤内联执行；共享脏工作区不创建提交。

**Goal:** 将 Skill 固定使用协议、动态能力目录和安装结果分离，并在同一用户 Turn 安装 Skill 后原子替换旧目录，使模型只看到一份最新目录和与之同源的工具 Schema。

**Architecture:** Runtime 在 Agent 提示词后追加版本化、稳定且不含具体 Skill 名单的 Skill 使用协议；`SkillCatalogContextSource` 只输出当前能力快照中的元数据。能力变化时，Runner 不改变模型循环，只通过纯上下文操作把旧 segment 层整体替换为新层，并同步 `ContextBuildResult.segments`。`ensure_agent_skills` 只报告事实，不再生成另一份待调用清单。

**Tech Stack:** TypeScript 7、Vitest 4、pnpm workspace、Remote ACP Runtime、Ollama 与 OpenAI-compatible Responses Provider。

**Status:** V1 已实现并通过自动验证；真实矩阵按用户更新后的验收口径为 4/6 功能通过，因此不创建 V2。

---

## File structure

- Create `apps/remote/src/skills/skill-context.ts`: 保存可精确选择和回滚的 V1 固定协议，以及纯元数据目录序列化。
- Modify `apps/remote/src/conversation/context-assembler.ts`: 使用目录序列化器，并提供原子替换 context segment 层的纯操作。
- Modify `apps/remote/src/runtime/agent-runtime.ts`: 把固定协议追加到 Runtime system prompt；能力刷新时调用 segment 替换操作，不改变模型请求/工具执行循环。
- Modify `apps/remote/src/skills/ensure-agent-skills-tool.ts`: 删除 `required_next_action`，只返回安装事实和能力已变化事实。
- Modify `apps/remote/src/skills/skill-tool-provider.ts`: 让工具描述只表达安装、加载、读取三种职责边界。
- Modify `apps/remote/src/index.ts`: 默认 Agent 提示词移除 Skill 动态行为说明，避免与 Runtime 固定协议重复。
- Modify `apps/remote/test/capabilities.test.ts`: 锁定“固定协议不含名单、动态目录只含元数据”的边界。
- Modify `apps/remote/test/runtime.test.ts`: 锁定固定协议进入 system prompt。
- Modify `apps/remote/test/context-message-budget.test.ts`: 锁定能力变化后旧目录被原子移除、新目录位于原上下文层位置。
- Modify `apps/remote/test/skills/skill-installation.test.ts`: 锁定 ensure 结果没有下一动作清单。
- Create `docs/testing/skill-context-v1-test-report.md`: 记录精确上下文版本、固定原始提示词的 hash、每个模型档位、四个来源对应的 Skill 调用和 HTML 产物证据。

### Task 1: 固定 V1 上下文契约

**Files:**
- Create: `apps/remote/src/skills/skill-context.ts`
- Test: `apps/remote/test/capabilities.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
expect(skillUseProtocol("v1")).toContain("当前 JSON Schema");
expect(skillUseProtocol("v1")).not.toContain("sandbox-notes");
expect(catalog.content).toContain(JSON.stringify([{ name: "demo-skill", description: "演示渐进加载。用户要求演示 Skill 时使用。", trust: "approved" }]));
expect(catalog.content).not.toContain("activate_skill({");
expect(catalog.content).not.toContain("安装或绑定只代表可用");
```

- [ ] **Step 2: Run the focused test and verify the old coupled catalog fails**

Run: `pnpm --filter @kindergarten/remote test -- capabilities.test.ts`

Expected: FAIL because the current catalog embeds fixed prose and concrete activation examples.

- [ ] **Step 3: Implement the versioned stable protocol and metadata-only serializer**

```ts
export const DEFAULT_SKILL_CONTEXT_VERSION = "v1" as const;

const protocols = {
  v1: [
    "【Skill 使用协议】",
    "- Skill 是按需加载的任务执行说明。",
    "- <available_skills> 只包含当前 Agent 可用 Skill 的元数据；目录可见不代表完整指令已经加载。",
    "- 用户明确指定 Skill，或任务语义与 description 匹配时，在执行相关任务前调用 activate_skill。",
    "- activate_skill 只加载一个 Skill 的完整 SKILL.md，不安装 Skill，也不执行原始任务。",
    "- 工具参数字段和允许值以当前 JSON Schema 为唯一依据。",
    "- 加载后遵守 SKILL.md；仅在其中明确引用且当前任务需要时读取附属资源。",
  ].join("\n"),
};
```

动态目录只保留 `<available_skills>`、`JSON.stringify(items)` 和结束标签。

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm --filter @kindergarten/remote test -- capabilities.test.ts`

Expected: PASS.

### Task 2: 原子替换动态能力目录

**Files:**
- Modify: `apps/remote/src/conversation/context-assembler.ts`
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Test: `apps/remote/test/context-message-budget.test.ts`

- [ ] **Step 1: Write a failing replacement test**

```ts
replaceContextSegmentsInPlace(built, [oldCatalog], [newCatalog]);
expect(built.messages.filter((item) => item.content.includes("sandbox-notes"))).toHaveLength(0);
expect(built.messages.filter((item) => item.content.includes("frontend-design"))).toHaveLength(1);
expect(built.messages.at(-1)).toMatchObject({ role: "user", content: "当前任务" });
expect(built.segments).toEqual([newCatalog]);
```

- [ ] **Step 2: Run the focused test and verify the helper is absent**

Run: `pnpm --filter @kindergarten/remote test -- context-message-budget.test.ts`

Expected: FAIL because `replaceContextSegmentsInPlace` does not exist.

- [ ] **Step 3: Implement whole-layer replacement**

The helper finds current segment messages by `(kind, exact content)`, removes that whole layer, inserts the next layer at the first old segment position, rebuilds matching observations, and replaces `built.segments`. The Runner calls it after resolving the new capability snapshot. No model-round, retry, ToolRuntime, ledger, or Turn state transition is changed.

- [ ] **Step 4: Run the focused test and runtime tests**

Run: `pnpm --filter @kindergarten/remote test -- context-message-budget.test.ts runtime.test.ts`

Expected: PASS, including existing 24-round, output classification, invalid argument guard, and tool-loop tests.

### Task 3: Simplify ensure and activate responsibilities

**Files:**
- Modify: `apps/remote/src/skills/ensure-agent-skills-tool.ts`
- Modify: `apps/remote/src/skills/skill-tool-provider.ts`
- Test: `apps/remote/test/skills/skill-installation.test.ts`

- [ ] **Step 1: Change the ensure-result test first**

```ts
expect(model.result?.installed_skill_names).toEqual(["frontend-design"]);
expect(model.result?.capabilities_changed).toBe(true);
expect(model.result).not.toHaveProperty("required_next_action");
expect(model.instruction).toBeUndefined();
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @kindergarten/remote test -- test/skills/skill-installation.test.ts`

Expected: FAIL because the current output contains `skill_names`, `required_next_action`, and an imperative instruction.

- [ ] **Step 3: Implement factual output and concise tool descriptions**

The success result keeps job/item facts and adds only:

```ts
{
  installed_skill_names: skillNames,
  capabilities_changed: true,
}
```

`ensure_agent_skills` describes installation/binding and the next-round catalog update; `activate_skill` describes loading one selected SKILL.md. Neither emits a concrete call list.

- [ ] **Step 4: Run Skill tests**

Run: `pnpm --filter @kindergarten/remote test -- test/skills/skill-installation.test.ts capabilities.test.ts`

Expected: PASS.

### Task 4: Put the stable protocol above dynamic data

**Files:**
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/src/index.ts`
- Test: `apps/remote/test/runtime.test.ts`

- [ ] **Step 1: Extend the captured-system-prompt test**

```ts
expect(provider.lastInput?.systemPrompt).toContain("【Skill 使用协议】");
expect(provider.lastInput?.systemPrompt).toContain("当前 JSON Schema");
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @kindergarten/remote test -- runtime.test.ts`

Expected: FAIL because V1 protocol is not yet appended by Runtime.

- [ ] **Step 3: Append V1 using an explicit selector and clean the future default Agent prompt**

Use `MK_SKILL_CONTEXT_VERSION=v1` as the defaulted selector. Unknown versions fail startup/Turn assembly instead of silently falling back. The existing output contract remains after the Agent prompt; the Skill protocol is stable and contains no installed names. The default Agent prompt keeps general model, security, sandbox and tool-result rules but removes `available_skills` behavior.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --filter @kindergarten/remote test -- runtime.test.ts capabilities.test.ts`

Expected: PASS.

### Task 5: Static verification

**Files:**
- Verify all files above.

- [ ] **Step 1: Run formatting/dead-copy search**

Run: `rg -n "required_next_action|activate_skill\\(\\{\\\"name\\\"|sandbox-notes" apps/remote/src`

Expected: no `required_next_action`, no dynamic concrete activation example, and no Skill name in stable context code.

- [ ] **Step 2: Run Remote typecheck and tests**

Run: `pnpm --filter @kindergarten/remote typecheck`

Run: `pnpm --filter @kindergarten/remote test`

Expected: both exit 0.

- [ ] **Step 3: Run repository-wide typecheck and tests**

Run: `pnpm typecheck`

Run: `pnpm test`

Expected: both exit 0; unrelated pre-existing failures are reported with exact package/test names and not hidden.

### Task 6: Fixed-prompt model matrix

**Files:**
- Create: `docs/testing/skill-context-v1-test-report.md`
- Runtime artifacts: `apps/remote/data/workspaces/<session-id>/`

- [ ] **Step 1: Record immutable test inputs**

Save the exact user-provided prompt without changing a character, its SHA-256, `MK_SKILL_CONTEXT_VERSION=v1`, current model IDs, supported product profiles, Agent ID, and source commit/worktree diff fingerprint in the report.

- [ ] **Step 2: Run fresh sessions for Qwen 8B and 大聪明 at every supported concrete profile**

For each matrix cell, create a fresh Session with the same Agent and profile override, send the exact fixed prompt once, wait for the Turn terminal state, and inspect persisted Turn facts rather than judging from the visible answer alone.

- [ ] **Step 3: Apply the hard acceptance rule**

A cell passes only when both are true:

1. `fileRelativePaths` or workspace evidence contains a created `.html` file whose content implements the requested site rather than a placeholder.
2. 按用户在实测过程中的最新口径，successful `activate_skill` calls 同时覆盖：至少一个安装来源为 `greensock/gsap-skills` 的 Skill，以及 `frontend-design`、`design-brief`、`impeccable-design-polish` 三者中的至少一个。

- [ ] **Step 4: Enforce the stop gate**

If any V1 cell passes, do not alter the context again; publish the entire V1 matrix and wait for the user. 本次 V1 的大聪明四档均达到更新后的功能验收口径，因此不创建 V2。只有未来同一口径下所有 V1 cell 都失败时，才保留 V1 常量、增加单独命名的 `v2`，并仅通过 `MK_SKILL_CONTEXT_VERSION` 切换和回滚。

## Self-review

- Spec coverage: stable protocol, metadata-only catalog, atomic refresh, factual ensure result, exact rollback, fixed prompt, two models, all supported profiles, updated HTML plus two类 Skill coverage gate, and stop condition are each mapped to a task.
- Placeholder scan: no TBD/TODO/future placeholder appears; the conditional V2 action is fully specified and is executed only when the user-defined all-fail condition is met.
- Type consistency: `installed_skill_names`, `capabilities_changed`, `MK_SKILL_CONTEXT_VERSION`, and `replaceContextSegmentsInPlace` use one spelling throughout.
