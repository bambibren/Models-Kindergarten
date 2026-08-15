# Model Reasoning Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-neutral reasoning profiles that are declared by ModelStudent capabilities, defaulted by Agent, optionally overridden for the current ACP Session, and frozen as the exact provider-native configuration on every Turn.

**Architecture:** Keep product semantics (`auto`, `fast`, `balanced`, `deep`, `max`) in shared contracts and keep native values such as OpenAI `xhigh` inside Provider adapters and immutable Turn snapshots. Use ACP `SessionConfigOption` with category `thought_level` for the conversation override, so the browser never hides execution configuration in prompt text or browser-only storage. Resolve the effective value once at the Turn boundary with precedence `Session override > Agent default > Model default`.

**Tech Stack:** TypeScript 7, React 19, Zustand, ACP SDK 1.3, Vitest 4, Ollama Chat API, OpenAI-compatible Responses API.

---

## File map

| Responsibility | Files |
|---|---|
| Provider-neutral contracts and validators | `packages/contracts/src/reasoning.ts`, `packages/contracts/src/agent-management.ts`, `packages/contracts/src/control-api.ts`, `packages/contracts/src/index.ts` |
| Turn-boundary policy resolution | `apps/remote/src/reasoning/reasoning-resolver.ts`, `apps/remote/src/runtime/turn-scope.ts`, `apps/remote/src/runtime/agent-runtime.ts` |
| Session persistence and ACP config option | `apps/remote/src/repository/session-types.ts`, `apps/remote/src/repository/session-repository.ts`, `apps/remote/src/acp/kindergarten-agent.ts` |
| Model capability and native serialization | `apps/remote/src/model/model-provider.ts`, `apps/remote/src/model/model-student-catalog.ts`, `apps/remote/src/model/ollama-provider.ts`, `apps/remote/src/model/responses-api-provider.ts`, `apps/remote/src/model/fixture-provider.ts` |
| Agent and session UI | `apps/web/src/product/AgentEditorPage.tsx`, `apps/web/src/product/HomePage.tsx`, `apps/web/src/acp/acp-client.ts`, `apps/web/src/App.tsx`, `apps/web/src/components/composer/Composer.tsx` |
| Demo projection | `apps/web/src/demo/demo-types.ts`, `apps/web/src/demo/demo-data.ts`, `apps/web/src/demo/agent-editor/AgentEditorPage.tsx`, `apps/web/src/demo/session/SessionDemoPage.tsx` |
| Product contract | `docs/REASONING_POLICY.md`, `docs/MODEL_ADMISSION.md`, `docs/ARCHITECTURE.md` |

### Task 1: Lock provider-neutral contracts

- [x] Add `ReasoningProfile`, concrete profile, model capability, and resolved Turn snapshot types.
- [x] Reject provider-native values such as `xhigh` at product/API boundaries.
- [x] Require new Agent writes to contain a default profile while normalizing old Agent records to `auto`.
- [x] Expose the full reasoning capability in `ModelStudentSummary`.
- [x] Run `pnpm --filter @kindergarten/contracts test` and expect all contract tests to pass.

### Task 2: Resolve and freeze every Turn

- [x] Add a pure resolver for `Session override > Agent default > Model default`.
- [x] Clamp unsupported semantic profiles to the nearest supported concrete profile deterministically.
- [x] Put the Session override in `TurnScope` and the resolved snapshot in `ModelInput`, Runtime observation, Agent snapshot hash, and `TurnExecutionRecord`.
- [x] Verify an Agent edit or Session setting change after Turn start cannot mutate the current snapshot.
- [x] Run the focused resolver and Runtime tests and expect them to pass.

### Task 3: Persist Session override through ACP

- [x] Add an optional concrete `reasoningProfileOverride` to Session V4 without invalidating existing files.
- [x] Add a repository method that atomically sets or clears it and rejects changes while a Turn is active at the ACP boundary.
- [x] Return a `thought_level` select from ACP `session/new`, `session/load`, and `session/resume` only when the bound model is adjustable.
- [x] Handle `session/set_config_option`, reject unsupported values for the bound model, and return the complete updated option list.
- [x] Test new/load/resume parity, persistence after reload, clear-to-Agent-default, unsupported values, and running-Turn rejection.

### Task 4: Map profiles in Provider adapters

- [x] Declare Ollama Qwen reasoning as a boolean/toggle capability and map `fast` to `think:false`, the model default to `think:true`.
- [x] Declare Responses effort capability and map `fast/balanced/deep/max` to `low/medium/high/xhigh` for the configured GPT-5-compatible model.
- [x] Send `reasoning.effort` and `reasoning.summary:auto` in the actual Responses request and provider-input disclosure.
- [x] Do not send incompatible sampling temperature with an active GPT-5 reasoning effort.
- [x] Preserve complete Responses output items needed by a `store:false` reasoning Tool loop; never substitute visible reasoning summary for opaque continuation state.
- [x] Test exact JSON, text/reasoning streaming, parallel Tool IDs, continuation, usage, and failed terminal events against a local HTTP/SSE server.

### Task 5: Add Agent default and Session controls

- [x] Add the five semantic choices to Agent create/edit and save through the existing Control API.
- [x] Advertise ACP Session config option support from the browser client.
- [x] Populate the formal Composer from ACP response state; setting a value must call `session/set_config_option` and remain selected for the current Session.
- [x] Disable changes while a Prompt Turn is active and provide “跟随 Agent” to clear the override.
- [x] Add the same selector to the new-session home composer; carry it through `SessionLaunchDraft`, set the ACP option after session creation, then send the first Prompt.
- [x] Hide the control for a fixed model and list only profiles supported by the selected model.

### Task 6: Keep Demo and documentation truthful

- [x] Update Demo model capability fixtures from a generic reasoning boolean to structured, model-specific capabilities.
- [x] Show Agent default and current-session override in the latest Demo without calling Remote from `/demo/*`.
- [x] Document ownership, precedence, native mapping, migration, security, token semantics, and acceptance criteria in `docs/REASONING_POLICY.md`.
- [x] Cross-link the contract from Model Admission and Architecture without claiming unimplemented providers are selectable.

### Task 7: Verify end to end

- [x] Run `pnpm --filter @kindergarten/contracts test`.
- [x] Run `pnpm --filter @kindergarten/remote test` and `pnpm --filter @kindergarten/remote typecheck`.
- [x] Run `pnpm --filter @kindergarten/web test`, `typecheck`, and `build`.
- [x] Run root `pnpm typecheck`, `pnpm test`, and `pnpm build`; distinguish pre-existing dirty-worktree failures from feature regressions.
- [x] Start Remote and Web, open the Agent editor and a real Session, change the Session thought level, send a prompt, and verify the persisted Turn snapshot contains the expected native parameter.
- [x] Verify changing the Agent default affects a later Turn only, while an explicit Session override continues to win until “跟随 Agent” is selected.
