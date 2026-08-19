# Context Lab Complete Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each Context Lab lane reuse the production Agent policy form and expose the real resolved model context read-only, while intentionally omitting history, memory, and difference-summary UI.

**Architecture:** Extract the policy subset shared by `AgentInput` and `ExperimentContextPolicy` into a production React component. Keep experiment-only state in a small pure module, render one active lane at a time using the Demo workbench pattern, and use the Remote context-preview response as the only source for read-only system instructions, tool schemas, Skill catalog, MCP context, and provider serialization. Runtime preview must use the selected ModelStudent and the same fixed system contracts as an actual prompt run.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Remote Control API, plain CSS.

---

### Task 1: Make Context Preview Runtime-Equivalent

**Files:**
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/src/experiments/context-preview-service.ts`
- Test: `apps/remote/test/experiments/context-preview-service.test.ts`

- [ ] **Step 1: Write failing preview-parity tests**

Add coverage that asserts the requested `modelStudentId` is passed to `RuntimeCapabilityResolver.preview`, and that both `contextSummary` and `providerInput` receive the same appended Runtime contracts used by `AgentRunner`.

```ts
expect(resolver.preview).toHaveBeenCalledWith(
  "local-admin",
  policy,
  "生成页面",
  "target-student",
);
expect(result.contextSummary.items[0]?.raw?.value).toContain("【每轮响应契约】");
expect(result.providerInput.value).toContain("【Skill 使用协议】");
```

- [ ] **Step 2: Run the focused Remote test and confirm failure**

Run: `pnpm --filter @kindergarten/remote test -- context-preview-service.test.ts`

Expected: FAIL because preview currently omits the model ID and passes the unextended Agent prompt to the serializer.

- [ ] **Step 3: Export one Runtime system-prompt builder**

Rename the private helper to an exported function and use it in both the actual runner and all preview paths.

```ts
export function buildRuntimeSystemPrompt(systemPrompt: string): string {
  const prompt = systemPrompt.trimEnd();
  const contracts = [
    MODEL_OUTPUT_CONTRACT,
    FILE_ARTIFACT_DELIVERY_CONTRACT,
    ARTIFACT_MENTION_CONTRACT,
    skillUseProtocol(configuredSkillContextVersion()),
  ].join("\n\n");
  return prompt ? `${prompt}\n\n${contracts}` : contracts;
}
```

- [ ] **Step 4: Use selected model and final system instructions in preview**

```ts
const resolved = await this.resolver.preview(
  ownerId,
  input.policy,
  input.promptText,
  input.modelStudentId,
);
const systemPrompt = buildRuntimeSystemPrompt(resolved.agent.systemPrompt);
```

Pass `systemPrompt` to `buildContextSummary` and `serializeModelInput`.

- [ ] **Step 5: Run focused and existing Runtime tests**

Run: `pnpm --filter @kindergarten/remote test -- context-preview-service.test.ts runtime.test.ts`

Expected: PASS.

### Task 2: Extract the Production Agent Policy Form

**Files:**
- Create: `apps/web/src/product/AgentPolicyFields.tsx`
- Create: `apps/web/src/product/AgentPolicyFields.test.tsx`
- Modify: `apps/web/src/product/AgentEditorPage.tsx`

- [ ] **Step 1: Write a rendering test for the shared policy fields**

The test must prove that the component renders real Tool enable/permission controls, ready Skills, connected MCPs, and conditionally omits history and memory.

```tsx
const html = renderToStaticMarkup(<AgentPolicyFields
  value={policy}
  builtinToolIds={["read_file", "web_search"]}
  skills={[readySkill]}
  mcps={[connectedMcp]}
  onChange={() => undefined}
  showHistory={false}
  showMemory={false}
/>);
expect(html).toContain("web_search");
expect(html).toContain("每次询问");
expect(html).toContain("frontend-design");
expect(html).not.toContain("聊天历史");
expect(html).not.toContain("Memory");
```

- [ ] **Step 2: Implement a shared policy value contract**

```ts
export interface AgentPolicyValue {
  systemPrompt: string;
  builtinTools: BuiltinToolBinding[];
  skillInstallationIds: string[];
  mcps: McpBinding[];
  historyPolicy: HistoryPolicy;
  memoryPolicy: { mode: "off" };
}
```

The component owns only field rendering and immutable updates; it does not load data or save records.

- [ ] **Step 3: Preserve the production Agent form behavior**

Render all capability-option Tool IDs, preserve permission controls, list only ready Skills, list only connected MCP installations, and keep the existing MCP binding construction that enables discovered tools/resources.

- [ ] **Step 4: Replace duplicated fields in AgentEditorPage**

Keep name, description, save status, and save button in `AgentEditorPage`; pass the policy subset into `AgentPolicyFields` with history and memory visible.

- [ ] **Step 5: Run the shared-form test and Web typecheck**

Run: `pnpm --filter @kindergarten/web test -- AgentPolicyFields.test.tsx`

Run: `pnpm --filter @kindergarten/web typecheck`

Expected: PASS.

### Task 3: Make Experiment Lane State Match the Confirmed Semantics

**Files:**
- Create: `apps/web/src/product/context-lab-state.ts`
- Create: `apps/web/src/product/context-lab-state.test.ts`
- Modify: `apps/web/src/product/ContextLabPage.tsx`

- [ ] **Step 1: Write failing state tests**

Cover these invariants:

```ts
expect(initialLanes(agent, policy, false)[0]?.policy)
  .toEqual(initialLanes(agent, policy, false)[1]?.policy);
expect(addLane(lanes, "b")[2]?.policy).toEqual(lanes[1]?.policy);
expect(importAgentPolicy(lanes, "b", agent)[0]?.policy).toEqual(lanes[0]?.policy);
```

History mode keeps A locked with `reuse_snapshot`; this task must not change the existing history-result reuse behavior.

- [ ] **Step 2: Implement pure lane helpers**

Create A/B as independent structured clones with identical policies. Add C by cloning the active editable lane, or the first editable lane when the active lane is locked. Importing an Agent replaces only the selected editable lane policy.

- [ ] **Step 3: Remove the automatic B prompt tweak**

Delete `tweak(policy)` from initial A/B and C creation. Keep only the existing distinct-policy validation used to enable experiment execution; do not render a difference summary.

- [ ] **Step 4: Run state tests**

Run: `pnpm --filter @kindergarten/web test -- context-lab-state.test.ts`

Expected: PASS.

### Task 4: Render Complete Read-Only Resolved Context

**Files:**
- Create: `apps/web/src/product/ContextPreviewPanel.tsx`
- Create: `apps/web/src/product/ContextPreviewPanel.test.tsx`
- Modify: `apps/web/src/product/ContextLabPage.tsx`

- [ ] **Step 1: Write a filtering and raw-render test**

```tsx
expect(html).toContain("最终系统指令");
expect(html).toContain("【每轮响应契约】");
expect(html).toContain("可用工具");
expect(html).toContain("可用技能");
expect(html).toContain("Provider 完整输入");
expect(html).not.toContain("对话历史");
expect(html).not.toContain("较早历史已裁剪");
```

- [ ] **Step 2: Render only current-turn context categories**

Filter out `session_history` and `truncated_history`. Render system instructions, available Tool schemas, Skill catalog, MCP resource catalog, and preloaded MCP data as collapsed read-only rows with trust, item count, token estimate, and Provider-adapter raw text.

- [ ] **Step 3: Render the full Provider serialization read-only**

Add a final disclosure for `ContextPreviewResponse.providerInput.value`. Do not duplicate or invent history/memory UI.

- [ ] **Step 4: Preserve full preview responses in ContextLab state**

Replace the three-number preview record with `Record<string, ContextPreviewResponse>`. Generate/refresh the active lane preview from the selected ModelStudent and policy, and show failures explicitly.

- [ ] **Step 5: Run preview-panel tests**

Run: `pnpm --filter @kindergarten/web test -- ContextPreviewPanel.test.tsx`

Expected: PASS.

### Task 5: Align Context Lab With the Demo Workbench and Agent Form

**Files:**
- Modify: `apps/web/src/product/ContextLabPage.tsx`
- Modify: `apps/web/src/product/product.css`

- [ ] **Step 1: Load the same option sources as AgentEditorPage**

Add `controlApi.capabilityOptions()`, `controlApi.skills()`, and `controlApi.mcps()` to the page load. Do not use Demo data or sessionStorage.

- [ ] **Step 2: Render an active-version rail**

Show A/B/C in a compact left rail, one active lane editor on the right, and an Add C action. Preserve locked history A and version deletion rules. Do not add a difference-summary component.

- [ ] **Step 3: Reuse AgentPolicyFields for the active lane**

Pass `showHistory={false}` and `showMemory={false}`. Keep the Agent import selector outside the shared field component and make its copy semantics explicit.

- [ ] **Step 4: Place read-only resolved context after editable policy**

Use one containment layer, warm-neutral disclosures, keyboard-accessible native `details`, monospaced raw text, and responsive single-column collapse below 820px.

- [ ] **Step 5: Preserve experiment behavior outside this scope**

Do not change source-turn A reuse, external history sourcing, experiment Session creation, evaluation navigation, scoring, or Runtime execution.

### Task 6: Full Verification

**Files:**
- Verify: `apps/web/src/product/**`
- Verify: `apps/remote/src/experiments/**`
- Verify: `apps/remote/src/runtime/**`

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @kindergarten/web test -- AgentPolicyFields.test.tsx ContextPreviewPanel.test.tsx context-lab-state.test.ts
pnpm --filter @kindergarten/remote test -- context-preview-service.test.ts runtime.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package typechecks and builds**

Run:

```bash
pnpm --filter @kindergarten/web typecheck
pnpm --filter @kindergarten/remote typecheck
pnpm --filter @kindergarten/web build
pnpm --filter @kindergarten/remote build
```

Expected: PASS.

- [ ] **Step 3: Run the full repository tests**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 4: Browser walkthrough**

Verify `/agents/new`, `/context-lab`, and `/context-lab?turnId=<completed-turn>` at desktop and narrow widths. Confirm full Agent fields, identical initial A/B, active-lane editing, no difference summary, no history/memory controls, read-only full system instructions, Tool/Skill/MCP context, provider raw input, and unchanged history A behavior.

- [ ] **Step 5: Review only the intended diff**

Run: `git diff --check` and inspect `git status --short`. Do not commit or alter unrelated user changes.
