# ModelStudent Admission Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify the front-end-only “新模型入园” Demo for Ollama, SiliconFlow Chat Completions, and custom Responses connections, then project the admitted ModelStudent consistently on the model home, Session Demo, and “我的 Models”.

**Architecture:** Keep the feature under `apps/web/src/demo` and reuse the isolated `/demo/*` router. Pure TypeScript helpers own provider presets, validation, deterministic model discovery, ModelStudent construction, and secret-free `sessionStorage` persistence. React owns only transient async UI phases and never calls Remote or a Provider. The production contract remains in `docs/MODEL_ADMISSION.md`; this plan does not implement Provider adapters, SecretStore, Remote APIs, ACP behavior, or real scoring.

**Tech Stack:** React 19, TypeScript, Vite 8, Vitest 4, plain CSS, Lucide React, browser `sessionStorage`.

---

**Execution constraint:** The worktree contains unrelated user changes. Do not run `git add` or `git commit`; preserve unrelated files and edit only the paths below.

## File map

| File | Responsibility |
|---|---|
| `apps/web/src/demo/model-admission/model-admission-state.ts` | Provider presets, validation, deterministic discovery, capability facts, ModelStudent construction, safe load/save/merge |
| `apps/web/src/demo/model-admission/model-admission-state.test.ts` | Three providers, validation, failures, ModelStudent, malformed storage and raw-Key exclusion |
| `apps/web/src/demo/model-admission/ModelAdmissionPage.tsx` | Three-step workflow and transient async presentation state |
| `apps/web/src/demo/model-admission/model-admission.css` | Warm-neutral desktop/mobile layout and visible states |
| `apps/web/src/demo/demo-types.ts` | Shared protocol, capability and nullable-score model types |
| `apps/web/src/demo/demo-data.ts` | Built-in ModelStudent fixtures with explicit protocol/capability facts |
| `apps/web/src/demo/DemoApp.tsx` | `/demo/model-admission` route |
| `apps/web/src/demo/DemoApp.test.ts` | Demo route and trailing-slash isolation test |
| `apps/web/src/demo/model-home/ModelHomePage.tsx` | Admission link, merged selector and “待评测” projection |
| `apps/web/src/demo/session/SessionDemoPage.tsx` | Resolve the same admitted student in a session |
| `apps/web/src/demo/me/MePage.tsx` | Dedicated “我的 Models” projection and admission entry |

## Task 1: Lock the shared ModelStudent contract

**Files:**
- Modify: `apps/web/src/demo/demo-types.ts`
- Modify: `apps/web/src/demo/demo-data.ts`

- [x] **Step 1: Replace the loose score-only type**

Use explicit wire-protocol and capability facts:

```ts
export type DemoProviderProtocol =
  | "ollama_native"
  | "openai_chat_completions"
  | "openai_responses";

export type DemoCapabilityState =
  | "supported"
  | "unsupported"
  | "unverified";

export interface DemoModelCapabilities {
  streaming: DemoCapabilityState;
  toolCalls: DemoCapabilityState;
  reasoning: DemoCapabilityState;
  usage: DemoCapabilityState;
}
```

- [x] **Step 2: Make the student safe to persist and honest about scoring**

`DemoModelStudent` contains `protocol`, `baseUrl`, optional masked `credentialHint`, capability facts, and `score: number | null`. New students always use `score: null` and `state: "待评测"`; the UI must never convert null into `0 分`.

- [x] **Step 3: Update all built-in fixtures**

Every fixture declares its actual protocol, base URL and capability states. The SiliconFlow fixture is a pending Demo student rather than a fake numeric score.

## Task 2: Implement pure admission and persistence helpers

**Files:**
- Create: `apps/web/src/demo/model-admission/model-admission-state.ts`
- Create: `apps/web/src/demo/model-admission/model-admission-state.test.ts`

- [x] **Step 1: Define exactly three product entries**

```ts
export type ModelAdmissionProviderId =
  | "ollama"
  | "siliconflow"
  | "custom_responses";
```

Map them respectively to `ollama_native`, `openai_chat_completions`, and `openai_responses`. Do not add a generic provider catalogue.

- [x] **Step 2: Implement provider-specific drafts and validation**

Export:

```ts
createAdmissionDraft(providerId?)
switchAdmissionProvider(draft, providerId)
updateAdmissionDraft(draft, patch)
validateAdmissionDraft(draft)
```

Rules:

- Ollama defaults to `http://127.0.0.1:11434` and does not require a Key.
- SiliconFlow uses the fixed preset `https://api.siliconflow.cn/v1` and requires a Key.
- Custom Responses requires a connection name, HTTPS Base URL, Key, and model ID.
- Switching providers returns a fresh draft so credentials never leak between protocols.

- [x] **Step 3: Implement deterministic Demo discovery**

`simulateAdmissionTest(draft)` never performs network I/O. It returns fixed Ollama/SiliconFlow models or the custom model ID. Any relevant input containing `invalid` returns a provider-specific, retryable Chinese error.

- [x] **Step 4: Build only a safe ModelStudent**

`buildDemoModelStudent(draft, model, id?)` copies only approved student fields. Cloud students store `credentialHint` such as `•••• 1234`; they never contain `apiKey`, headers, authorization, the full draft, or a Provider response body.

- [x] **Step 5: Keep safe persistence in the same focused module**

Export:

```ts
loadSavedModelStudents(storage)
saveModelStudent(storage, student)
mergeModelStudents(saved, builtIns)
```

`saveModelStudent` uses a field whitelist, upserts by ID, and writes the selected student ID. `loadSavedModelStudents` ignores malformed JSON and invalid rows.

- [x] **Step 6: Test security and domain behavior**

Cover all three providers, validation, deterministic errors, capability facts, `score: null`, raw-Key exclusion, malformed records, upsert, and merge behavior.

Run:

```bash
pnpm --filter @kindergarten/web exec vitest run \
  src/demo/model-admission/model-admission-state.test.ts
```

Expected: 8 tests pass.

## Task 3: Build the interactive admission page

**Files:**
- Create: `apps/web/src/demo/model-admission/ModelAdmissionPage.tsx`
- Create: `apps/web/src/demo/model-admission/model-admission.css`
- Modify: `apps/web/src/demo/DemoApp.tsx`
- Create: `apps/web/src/demo/DemoApp.test.ts`

- [x] **Step 1: Register the isolated route**

Register `/demo/model-admission` in `DemoApp`. Do not modify the real `App`, ACP client, Remote, chat store, or Provider code.

- [x] **Step 2: Render source-specific beginner fields**

- Ollama: editable service address and Remote-localhost explanation; no Key input.
- SiliconFlow: password Key field; fixed Base URL inside advanced information.
- Custom Responses: connection name, HTTPS Base URL, password Key, and model ID matching the screenshot-style configuration.
- Only use disposable Demo Key values in verification. The page explicitly tells users not to enter a real Key.

- [x] **Step 3: Implement visible async phases**

React owns:

```ts
type AdmissionPhase =
  | "editing"
  | "testing"
  | "selecting_model"
  | "probing"
  | "ready"
  | "failed"
  | "saving";
```

Use one timer ref, clear it before replacement and on unmount, disable duplicate actions while busy, use `aria-live="polite"`, and render failures with `role="alert"`.

- [x] **Step 4: Separate discovery from model health**

“测试连接并读取模型” only reveals model candidates. “测试这个模型” then projects streaming, Tool Call, reasoning, and token usage. Only `ready` enables “确认入园”.

- [x] **Step 5: Complete admission without real side effects**

Build and save the safe Demo student, clear the Key state, and navigate to:

```ts
location.href = "/demo/model-home?admitted=1";
```

The Demo does not save a real `ProviderConnection` and does not claim that a live service was connected.

## Task 4: Project the same student across Demo pages

**Files:**
- Modify: `apps/web/src/demo/model-home/ModelHomePage.tsx`
- Modify: `apps/web/src/demo/model-home/model-home.css`
- Modify: `apps/web/src/demo/session/SessionDemoPage.tsx`
- Modify: `apps/web/src/demo/me/MePage.tsx`

- [x] **Step 1: Replace the homepage placeholder**

Use a real `/demo/model-admission` link. Merge safe saved students with fixtures, remember the selected ID, and show the new student immediately after return.

- [x] **Step 2: Render nullable scores correctly**

Use `typeof score === "number" ? score + " 分" : "待评测"` in the selector and current-student card.

- [x] **Step 3: Resolve the selection in Session Demo**

Merge students before resolving `mk-demo-model-student`; a newly admitted student must not silently fall back to the first Ollama fixture.

- [x] **Step 4: Replace the generic Models placeholder**

“我的 Models” lists built-ins and admitted students with friendly name, upstream model ID, provider, protocol, score state, and a “新模型入园” action. It does not add credential editing, deletion, reconnect, or production management controls.

## Task 5: Finish visual and responsive behavior

**Files:**
- Create: `apps/web/src/demo/model-admission/model-admission.css`
- Reuse: `apps/web/src/demo/demo.css`

- [x] **Step 1: Reuse the locked warm-neutral design system**

Use the existing surface, line, ink, action, success, danger, focus, and mono tokens. Do not add a dark inspector, gradients, glow, floating metrics, file tree, or Runtime visualization.

- [x] **Step 2: Use a guided workbench layout**

Desktop uses a large form and a smaller sticky status panel. Provider choices are stacked, not a generic equal-card dashboard. Mobile turns the stepper and workbench into one column.

- [x] **Step 3: Preserve semantics and reduced motion**

Provider choices use a labelled `radiogroup`; model choices use native radios; errors are not color-only; global `:focus-visible` and `prefers-reduced-motion` rules remain effective.

## Task 6: Verify the scoped result

- [x] **Step 1: Run focused and full tests**

```bash
pnpm --filter @kindergarten/web test
```

Expected current result: 12 files and 43 tests pass.

- [x] **Step 2: Run typecheck and production build**

```bash
pnpm --filter @kindergarten/web typecheck
pnpm --filter @kindergarten/web build
```

Expected: both succeed. The existing Vite chunk-size warning is non-blocking and outside this feature.

- [x] **Step 3: Walk through all three providers**

Verify:

- Ollama finds two fixed local models and completes four capability rows.
- SiliconFlow shows a retryable invalid-Key state, clears it after editing, and discovers fixed cloud models.
- Custom Responses requires all three fields, preserves discovery while editing the optional nickname, completes four capability rows, and admits the chosen model.
- Home shows the admitted student selected with “待评测”.
- Session header resolves the admitted upstream model ID.
- “我的 Models” shows the same student and provides the admission entry.

- [x] **Step 4: Check responsive layout and browser errors**

At `390 × 844`, confirm `documentElement.scrollWidth === clientWidth`, the page remains one column, and all controls remain reachable. Confirm the tab has no console errors.

- [x] **Step 5: Inspect without staging or committing**

```bash
git diff --check
git status --short
```

Do not clean, stage, commit, or overwrite unrelated user changes.

## Production follow-up

This completed Demo plan is not the production implementation plan. Future Provider/Remote work must start from [MODEL_ADMISSION.md](../../MODEL_ADMISSION.md), including `ProviderConnection`, writable SecretStore, SSRF policy, Provider factory/registry, Session `modelStudentId`, real model discovery/probes, and the two new adapters. Browser-to-Remote interaction must continue to use the approved management contract plus ACP for chat; the upstream Responses SSE stream does not become a Browser SSE channel.
