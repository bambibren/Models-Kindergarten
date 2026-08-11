# Models Kindergarten Demo Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build five connected, hard-coded-data Demo experiences for the Models Kindergarten model home, session workspace, context lab, comparison results, and Admin profile without changing the real ACP chat behavior.

**Architecture:** Route `/demo/*` to an isolated `DemoApp` inside `apps/web/src/demo`, keeping the existing `App` as the only real ACP connection owner. Extend the existing Evaluation Demo only inside `apps/evaluation-web/src/demo`, and share visual semantics through focused Demo components rather than importing runtime state or ACP types.

**Tech Stack:** React 19, TypeScript, Vite 8, plain CSS, Lucide React, Streamdown for Markdown rendering, Vitest for pure state helpers.

---

## File map

### Web Demo

- Modify `apps/web/src/main.tsx`: choose `DemoApp` only for `/demo/*`; render the original `App` otherwise.
- Create `apps/web/src/demo/DemoApp.tsx`: path-based Demo page router.
- Create `apps/web/src/demo/demo-types.ts`: Demo-only view models.
- Create `apps/web/src/demo/demo-data.ts`: all hard-coded sessions, artifacts, experiments, and Admin resources.
- Create `apps/web/src/demo/demo.css`: locked warm-neutral tokens and common shell styles.
- Create `apps/web/src/demo/shared/DemoTopNav.tsx`: canonical Demo navigation.
- Create `apps/web/src/demo/shared/DemoChatStream.tsx`: context/thought/tool/answer projection.
- Create `apps/web/src/demo/model-home/ModelHomePage.tsx`: model home interactions.
- Create `apps/web/src/demo/session/SessionDemoPage.tsx`: collapsible session rail and artifact workspace.
- Create `apps/web/src/demo/session/ArtifactPanel.tsx`: Markdown and sandboxed static HTML renderers.
- Create `apps/web/src/demo/session/split-pane.ts`: pure 300px clamp helper.
- Create `apps/web/src/demo/session/split-pane.test.ts`: split boundary tests.
- Create `apps/web/src/demo/context-lab/ContextLabPage.tsx`: both experiment modes and editor UI.
- Create `apps/web/src/demo/context-lab/context-lab-state.ts`: version invariants, diff and run plan.
- Create `apps/web/src/demo/context-lab/context-lab-state.test.ts`: history reuse and 2–3 version tests.
- Create `apps/web/src/demo/me/MePage.tsx`: four Admin tabs, search and pagination.
- Create `apps/web/src/demo/me/me-data.ts`: pure search/pagination helper.
- Create `apps/web/src/demo/me/me-data.test.ts`: search and 10-row page tests.

### Evaluation Demo

- Modify `apps/evaluation-web/src/demo/agent-evaluation/AgentEvaluationDemoPage.tsx`: add saved list, save state, and full stream Answer Mode.
- Modify `apps/evaluation-web/src/demo/agent-evaluation/AgentComparisonGrid.tsx`: expose lane origin status.
- Modify `apps/evaluation-web/src/demo/agent-evaluation/types.ts`: add stream and comparison record types.
- Modify `apps/evaluation-web/src/demo/agent-evaluation/mock-data.ts`: add complete stream data and saved records.
- Modify `apps/evaluation-web/src/demo/agent-evaluation/agent-evaluation-demo.css`: warm-neutral list and chat-flow styles.
- Create `apps/evaluation-web/src/demo/agent-evaluation/DemoAgentStream.tsx`: context, thought, tool, answer renderers.
- Create `apps/evaluation-web/src/demo/agent-evaluation/ComparisonHistoryRail.tsx`: saved-only list and selected-item focus.
- Create `apps/evaluation-web/src/demo/agent-evaluation/comparison-state.ts`: saved-result selection helpers.
- Create `apps/evaluation-web/src/demo/agent-evaluation/comparison-state.test.ts`: saved-only and selection tests.

---

### Task 1: Add the isolated Demo router and canonical shell

- [ ] **Step 1: Write the route classifier in `DemoApp.tsx`.**

```ts
export function isDemoRoute(pathname: string): boolean {
  return pathname === "/demo/model-home"
    || pathname === "/demo/session"
    || pathname === "/demo/context-lab"
    || pathname === "/demo/me";
}
```

- [ ] **Step 2: Render `DemoApp` from `main.tsx` only when `isDemoRoute(location.pathname)` is true.**
- [ ] **Step 3: Build `DemoTopNav` with real anchors to all four Web Demo routes.**
- [ ] **Step 4: Add warm-neutral common tokens and ensure `body:has(.mk-demo-app)` overrides the real app's hidden overflow safely.**
- [ ] **Step 5: Run `pnpm --filter @kindergarten/web typecheck`; expected result is exit 0.**

### Task 2: Build the model home

- [ ] **Step 1: Render the model identity, static 53 score, Admin link, and three capability buttons.**
- [ ] **Step 2: Make novel/site buttons populate the prompt and make Context Lab navigate to `/demo/context-lab?mode=new`.**
- [ ] **Step 3: Place the composer immediately below the capability row and navigate a non-empty submission to `/demo/session?draft=home-prompt`.**
- [ ] **Step 4: Render three recent sessions by default and six after “查看更多”; “收起” restores three.**
- [ ] **Step 5: Verify all labels remain single-line at desktop widths and wrap safely at narrow widths.**

### Task 3: Build the session workspace and artifact split pane

- [ ] **Step 1: Add a 248px Admin session rail that collapses to a 64px icon rail without resetting selected session state.**
- [ ] **Step 2: Render one ordered Demo stream containing user, context, thought, two tools, Markdown answer, artifacts, and token metadata.**
- [ ] **Step 3: Add the Demo-only `turnId` Context Lab link inside the context summary row.**
- [ ] **Step 4: Write split clamp tests.**

```ts
expect(clampArtifactWidth(150, 900)).toBe(300);
expect(clampArtifactWidth(780, 900)).toBe(600);
expect(clampArtifactWidth(460, 900)).toBe(460);
```

- [ ] **Step 5: Implement pointer and keyboard resizing with a 300px minimum for artifact and chat.**
- [ ] **Step 6: Render Markdown with Streamdown and HTML through `<iframe sandbox="" srcDoc={...}>`.**
- [ ] **Step 7: Close the artifact without remounting the chat stream so scroll position remains stable.**
- [ ] **Step 8: At narrow width, provide “产物/聊天” view buttons instead of violating the 300px limits.**

### Task 4: Build both Context Lab modes

- [ ] **Step 1: Write pure initialization functions for `fresh_prompt` and `history_turn`.**
- [ ] **Step 2: Test that fresh mode creates A/B with `run`, while history mode creates locked A with `reuse_snapshot` and editable B with `run`.**
- [ ] **Step 3: Test the 2–3 version invariant, locked-A deletion protection, and strategy fingerprint difference.**
- [ ] **Step 4: Render editable Prompt for new mode and immutable user bubble for turn mode.**
- [ ] **Step 5: Render the 2–3 version rail, add/delete controls, estimated tokens, and read-only lock state.**
- [ ] **Step 6: Implement system, tools, skills, memory Demo, and history controls plus collapsed Ollama JSON preview.**
- [ ] **Step 7: Enable “开始对比实验” only for valid, meaningfully different strategies.**
- [ ] **Step 8: Navigate to port 5175 with `source=history_turn&turnId=...` or `source=fresh_prompt`.**

### Task 5: Replace Evaluation Answer Mode with full chat streams

- [ ] **Step 1: Extend each `DemoAgent` with ordered Context, Thought, Tool, and Answer items and a `runPolicy`.**
- [ ] **Step 2: Render Context, Thought, and Tool items as independent accessible disclosures; leave the final answer visible.**
- [ ] **Step 3: Label `reuse_snapshot` as “历史结果 · 未重跑” and `run` as “本次运行”.**
- [ ] **Step 4: Preserve the existing Annotation Mode and score calculations.**
- [ ] **Step 5: Run Evaluation tests and typecheck; expected result is exit 0.**

### Task 6: Add saved comparison history and save semantics

- [ ] **Step 1: Define saved records and filter helpers so unsaved results never enter the rail.**
- [ ] **Step 2: Parse `comparisonId`; saved deep links select that record, while new Context Lab results show no selected saved row.**
- [ ] **Step 3: Use `offsetTop`, `clientHeight`, and `scrollTop` to keep a deep selected row visible without `scrollIntoView`.**
- [ ] **Step 4: Replace Mock/UI badges with “保存本次对照实验结果” and implement idle/saving/saved states.**
- [ ] **Step 5: On save, insert the current result first and select it; expose a real link to `/demo/me?tab=experiments`.**

### Task 7: Build the Admin “我的” page

- [ ] **Step 1: Render Admin profile and experiments/models/MCPs/skills tabs.**
- [ ] **Step 2: Write tests showing experiments are searched by title/prompt/model and paged 10 per page.**
- [ ] **Step 3: Make experiment rows link to port 5175 with `comparisonId`.**
- [ ] **Step 4: Render read-only example lists for Models, MCPs, and Skills with honest Demo labels.**

### Task 8: Verify the full connected experience

- [ ] **Step 1: Run `pnpm --filter @kindergarten/web test`, typecheck, and build.**
- [ ] **Step 2: Run `pnpm --filter @kindergarten/evaluation-web test`, typecheck, and build.**
- [ ] **Step 3: Run `git diff --check`.**
- [ ] **Step 4: Start or reuse Web on 5174 and Evaluation Web on 5175.**
- [ ] **Step 5: Browser-walk model home → session artifact → history Context Lab → comparison save → My deep link.**
- [ ] **Step 6: Browser-walk fresh Context Lab → edit B → comparison and verify all lanes show disclosures.**
- [ ] **Step 7: Check browser console, horizontal overflow, disclosure keyboard focus, split limits, and selected-history visibility.**
- [ ] **Step 8: Run the Hallmark 74-gate self-check and fix any new Demo-specific failures.**

---

## Execution note

The worktree already contains unrelated and earlier in-progress changes. Do not create commits that would mix ownership; preserve all existing modifications and report only the files touched for this Demo experience.
