# Context Experiment V2 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The sub-skill is unavailable in this environment, so execute the same test-first checkpoints directly and do not pause for confirmation because the user already approved implementation.

**Goal:** Rebuild Context Experiment as a two-to-three-lane, single-turn experiment where every lane freezes its own Agent policy, ModelStudent, and reasoning profile, then always runs in a fresh Session while exposing the complete non-history runtime context read-only.

**Architecture:** Introduce a versioned V2 experiment record beside the read-only V1 record. Draft editing is separated from `prepare-run`; preparation validates real differences, resolves model reasoning, materializes capability/context snapshots, and creates pending run records. Runtime sessions bind directly to immutable experiment snapshots instead of hidden Agent records. Evaluation consumes those fresh runs and handles permission/elicitation in lane-local queues.

**Tech Stack:** TypeScript, React, Fastify-style control routes, AtomicJsonStore, Vitest, official ACP client/runtime.

---

### Task 1: Add versioned V2 contracts

**Files:**
- Modify: `packages/contracts/src/experiments.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/index.test.ts`

Add V2 draft, test configuration, immutable snapshots, run states, context preview details, optional execution metrics, and a V1/V2 union. Reject history/reuse fields in V2 and require two materially different effective test configurations at preparation time.

### Task 2: Persist V2 and prepare fresh runs

**Files:**
- Modify: `apps/remote/src/experiments/experiment-repository.ts`
- Modify: `apps/remote/src/experiments/experiment-service.ts`
- Modify: `apps/remote/src/experiments/experiment-routes.ts`
- Test: `apps/remote/test/experiments/experiment-service.test.ts`
- Test: `apps/remote/test/experiments/experiment-routes.test.ts`

Create V2 drafts without hidden Agents or Sessions, support draft updates, freeze snapshots in an idempotent `prepare-run`, create one fresh pending run per test, support cancellation, and keep V1 records read-only.

### Task 3: Resolve runtime from immutable experiment snapshots

**Files:**
- Modify: `apps/remote/src/experiments/context-preview-service.ts`
- Modify: `apps/remote/src/runtime/runtime-capability-resolver.ts`
- Modify: `apps/remote/src/runtime/turn-scope.ts`
- Modify: `apps/remote/src/session/session-binding-service.ts`
- Modify: `apps/remote/src/repository/session-types.ts`
- Test: `apps/remote/test/experiments/context-preview-service.test.ts`
- Test: `apps/remote/test/session/session-binding-service.test.ts`

Return the full read-only non-history context, model/reasoning resolution, capability catalog, and provider serialization. Bind a fresh experiment Session to its frozen snapshot without requiring a saved Agent. The actual experiment history is always zero.

### Task 4: Correct worksheet generation and missing metrics

**Files:**
- Modify: `apps/remote/src/experiments/annotation-worksheet-generator.ts`
- Modify: `apps/remote/src/experiments/experiment-service.ts`
- Modify: `apps/remote/src/index.ts`
- Test: `apps/remote/test/experiments/annotation-worksheet-generator.test.ts`
- Test: `apps/remote/test/experiments/experiment-service.test.ts`

Use the explicitly selected worksheet ModelStudent and its actual provider facts. Preserve unavailable runtime metrics as unavailable and keep the scorecard draft until required evidence exists.

### Task 5: Rebuild the Context Lab editor

**Files:**
- Modify: `apps/web/src/api/control-api.ts`
- Modify: `apps/web/src/product/context-lab-state.ts`
- Modify: `apps/web/src/product/ContextLabPage.tsx`
- Modify: `apps/web/src/product/ContextPreviewPanel.tsx`
- Modify: `apps/web/src/product/product.css`
- Test: `apps/web/src/product/context-lab-state.test.ts`
- Test: `apps/web/src/product/ContextPreviewPanel.test.tsx`

Reuse the formal Agent form in every lane, add per-lane ModelStudent and reasoning controls, show configured history count plus actual zero-history explanation, preview every lane's complete non-history context read-only, and create then prepare V2 experiments. Imported turns supply editable prompt/config facts only.

### Task 6: Rebuild evaluation lane interactions

**Files:**
- Modify: `apps/evaluation-web/src/experiment-acp-client.ts`
- Modify: `apps/evaluation-web/src/ExperimentEvaluationPage.tsx`
- Modify: `apps/evaluation-web/src/experiment.css`
- Test: `apps/evaluation-web/src/experiment-acp-client.test.ts`
- Test: `apps/evaluation-web/src/ExperimentEvaluationPage.test.tsx`

Run every lane once in a fresh Session. Replace global browser dialogs with independent FIFO permission/AskUser cards at each lane top, followed by the read-only model/reasoning panel and score strip. Remove retry/rerun/reuse controls and keep terminal experiments read-only.

### Task 7: Verify the complete chain

**Files:**
- Test: all affected package suites

Run contracts, Remote, Web, evaluation Web/service tests, full typecheck, and full build. Walk through `/context-lab` and a prepared evaluation in the browser, including independent model/reasoning choices, full read-only context, three fresh sessions, and lane-local intervention placement.
