# Agent Strategy UI Delta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote ModelStudent and saved Agent strategies to first-class Demo UI concepts while correcting artifact sizing, context-token semantics, chat experiment placement, and evaluation scoring layouts.

**Architecture:** Keep every new surface under `apps/web/src/demo` and reuse one shared Agent strategy fields component between Context Lab and Agent Editor. Treat an Agent as a named, saved context policy; historical Turn snapshots remain immutable experiment inputs, while standalone Agent policies carry dynamic history rules without fabricated token counts. Evaluation score projection remains local UI state and moves from column footers into comparison headers.

**Tech Stack:** React 19, TypeScript, Vite, plain CSS, Lucide React, Vitest.

---

### Task 1: Agent strategy domain and reusable form

**Files:**
- Modify: `apps/web/src/demo/demo-types.ts`
- Modify: `apps/web/src/demo/demo-data.ts`
- Modify: `apps/web/src/demo/context-lab/context-lab-state.ts`
- Create: `apps/web/src/demo/context-lab/AgentStrategyFields.tsx`
- Create: `apps/web/src/demo/agent-editor/agent-storage.ts`
- Test: `apps/web/src/demo/context-lab/context-lab-state.test.ts`
- Test: `apps/web/src/demo/agent-editor/agent-storage.test.ts`

- [ ] Add `DemoModelStudent` and `DemoAgentStrategy` types, including a saved Agent name, description, module snapshot, update time, and state.
- [ ] Change context module tokens to `number | null`; use `null` for runtime-dependent chat-history policies and numeric tokens only for historical snapshots.
- [ ] Add token-label helpers that render `运行时计算` for dynamic items and exclude them from known-token sums.
- [ ] Extract system/tools/skills/memory/history editors into `AgentStrategyFields`, shared by Context Lab and Agent Editor.
- [ ] Add session-storage serialization helpers so “保存为 Agent” creates a usable Demo Agent without a backend.
- [ ] Test historical numeric tokens, fresh dynamic history tokens, cloning, and storage round-trips.

### Task 2: Model-first home and Agent selector

**Files:**
- Modify: `apps/web/src/demo/model-home/ModelHomePage.tsx`
- Modify: `apps/web/src/demo/model-home/model-home.css`
- Modify: `apps/web/src/demo/shared/DemoTopNav.tsx`
- Modify: `apps/web/src/demo/demo.css`

- [ ] Add a prominent ModelStudent selector above the home title with model name, score, dropdown arrow, selectable model rows, and current-state mark.
- [ ] Move score and admission action out of the home top navigation; keep Admin identity and provide a compact home shell.
- [ ] Add a visually prominent “新模型入园” action with an inline Demo notice state.
- [ ] Add a composer-bottom Agent selector fixed to “默认 Agent” plus a working add link to `/demo/agent-editor?mode=create`.
- [ ] Preserve existing prompt shortcuts, history list, and submit routing.

### Task 3: Agent create/edit page and My Agents

**Files:**
- Modify: `apps/web/src/demo/DemoApp.tsx`
- Create: `apps/web/src/demo/agent-editor/AgentEditorPage.tsx`
- Create: `apps/web/src/demo/agent-editor/agent-editor.css`
- Modify: `apps/web/src/demo/me/MePage.tsx`
- Modify: `apps/web/src/demo/me/me.css`

- [ ] Register `/demo/agent-editor` without affecting the real ACP route owner.
- [ ] Build create mode with required custom Agent name, shared strategy fields, raw policy preview, and “保存为 Agent”.
- [ ] Build edit mode from `agentId`, preload the defined Agent name and module snapshot, and preserve the same form structure.
- [ ] Add “我的 Agents” to Admin tabs; list built-in and session-saved strategies and link every row to edit mode.
- [ ] Verify all create/edit/list links are real and keyboard accessible.

### Task 4: Context Lab import and token semantics

**Files:**
- Modify: `apps/web/src/demo/context-lab/ContextLabPage.tsx`
- Modify: `apps/web/src/demo/context-lab/context-lab-state.ts`
- Modify: `apps/web/src/demo/context-lab/context-lab.css`
- Test: `apps/web/src/demo/context-lab/context-lab-state.test.ts`

- [ ] Add “导入已有 Agent 策略” only in the active version editor header.
- [ ] Open an Agent picker, then replace only the active editable version modules from the selected Agent.
- [ ] Preserve 2–3 version behavior, historical A locking, and experiment-difference validation.
- [ ] Display standalone history as “运行时计算”; keep 162 tokens only in the historical Turn snapshot.

### Task 5: Session artifact and context-entry layout

**Files:**
- Modify: `apps/web/src/demo/session/split-pane.ts`
- Modify: `apps/web/src/demo/session/split-pane.test.ts`
- Modify: `apps/web/src/demo/session/SessionDemoPage.tsx`
- Modify: `apps/web/src/demo/shared/DemoChatStream.tsx`
- Modify: `apps/web/src/demo/session/session-demo.css`

- [ ] Add a pure default-width helper that reserves 350px for chat and gives the remaining width to the artifact, while keeping both 300px minimums.
- [ ] Apply that width each time an artifact opens; preserve drag, keyboard resize, double-click reset, and narrow-screen switching.
- [ ] Replace the context `<details>` wrapper with an accessible title-row toggle so the experiment link sits immediately after the summary.
- [ ] Render the expanded context panel on its own full-width row so the link never changes panel width.

### Task 6: Evaluation score headers and responsive understanding layout

**Files:**
- Modify: `apps/evaluation-web/src/demo/agent-evaluation/AgentComparisonGrid.tsx`
- Modify: `apps/evaluation-web/src/demo/agent-evaluation/AgentEvaluationDemoPage.tsx`
- Modify: `apps/evaluation-web/src/demo/agent-evaluation/ComparisonHistoryRail.tsx`
- Modify: `apps/evaluation-web/src/demo/agent-evaluation/agent-evaluation-demo.css`

- [ ] Add an optional dynamic score projection to each comparison-column header.
- [ ] Pass understanding/planning/output scores to headers and remove the footer `AnnotationLiveScore` row.
- [ ] Use a container-query layout: at wide panel widths place the checkbox requirement pool left and the complete three-column comparison right; otherwise stack them.
- [ ] Remove the selected history border and programmatic focus outline while retaining deterministic scroll positioning.
- [ ] Keep Summary and Execution tabs intact.

### Task 7: Verification and browser walkthrough

**Files:**
- Verify: `apps/web/src/demo/**`
- Verify: `apps/evaluation-web/src/demo/agent-evaluation/**`

- [ ] Run Web and Evaluation typechecks, tests, builds, and `git diff --check`.
- [ ] Verify model selection, admission notice, Agent selector, Agent save/edit/list, and Context Lab import in the browser.
- [ ] Verify artifact opens with 350px chat, context entry layout, header scores, responsive side-by-side/stacked understanding layout, and borderless selected history.
- [ ] Test desktop and 320px viewports, inspect console errors, and leave the model home open.
