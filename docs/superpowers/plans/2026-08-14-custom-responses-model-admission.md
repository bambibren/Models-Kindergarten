# Custom Responses Model Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **实施状态（2026-08-14）：** Task 1～6 的代码、自动测试与全仓构建已完成；Task 7 的文档同步和本地服务验收已进入收口。真实凭据录入、安装“`大聪明`”和真实 `max → xhigh` Turn 验证仍等待操作前确认。

**Goal:** Add a production ModelStudent admission flow for arbitrary HTTPS OpenAI Responses-compatible endpoints, then create and verify a real custom ModelStudent through the browser.

**Architecture:** The Control API owns a two-phase test/install workflow. A test keeps the raw API Key only in a short-lived in-memory vault, probes the endpoint's actual streaming, function-calling, usage, and accepted reasoning efforts, and persists only a redacted test record. Installation writes the Key to macOS Keychain, persists a ProviderConnection plus ModelStudent record, and registers a `ResponsesApiProvider` in a multi-provider catalog used by Session binding and Runtime resolution. The browser only receives public records and discovered capability facts.

**Tech Stack:** TypeScript 7, React 19, Vitest, Node 22 fetch/SSE, AtomicJsonStore, macOS Keychain, ACP 1.3 for chat and the existing localhost Control API for management.

---

### Task 1: Public admission contracts and validation

**Files:**
- Create: `packages/contracts/src/model-admission.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/management-contracts.test.ts`

- [ ] Define `ResponsesModelCandidateInput`, `ModelStudentTestRecord`, `ProviderConnectionView`, `ManagedModelStudentRecord`, and install input types. Public types must never contain `apiKey`, `credentialRef`, Authorization headers, or raw upstream responses.
- [ ] Parse a candidate with `displayName`, `baseUrl`, `model`, and transient `apiKey`; require a normalized HTTPS URL without credentials, query, or fragment and bounded non-empty strings.
- [ ] Represent probe results as explicit facts: streaming, tool calls, usage, thought summary, accepted native efforts, and the derived product-level `ModelReasoningCapability`.
- [ ] Add parser tests for valid custom Responses input, malformed URLs, missing credentials, unknown properties, and serialized public records that cannot contain a fake secret sentinel.
- [ ] Run `pnpm --filter @kindergarten/contracts test` and `pnpm --filter @kindergarten/contracts typecheck`; expect all tests and typechecking to pass.

### Task 2: Secret lifecycle and outbound URL policy

**Files:**
- Modify: `apps/remote/src/mcp/secret-store.ts`
- Create: `apps/remote/src/model/remote-model-url-policy.ts`
- Test: `apps/remote/test/model-admission-security.test.ts`

- [ ] Extend the host secret boundary with explicit Keychain `write` and `delete` operations while keeping the existing read-only `SecretStore` port compatible with MCP consumers.
- [ ] Store model credentials under a generated service key; never derive a secret identifier from the API Key and never return it through Control API responses.
- [ ] Validate HTTPS on every admission and every runtime request, resolve DNS, reject loopback/private/link-local/reserved addresses, reject URL credentials, and disable redirects so a Bearer token cannot be forwarded to another host.
- [ ] Test public and private IPv4/IPv6 cases, redirect rejection, Keychain command argument boundaries using a fake executor, and error redaction with a unique secret sentinel.
- [ ] Run the targeted Remote security tests and typecheck.

### Task 3: Endpoint-specific Responses capability probe

**Files:**
- Create: `apps/remote/src/model/responses-capability-probe.ts`
- Modify: `apps/remote/src/model/model-provider.ts`
- Modify: `apps/remote/src/model/responses-api-provider.ts`
- Modify: `apps/remote/test/support/responses-mock-server.ts`
- Test: `apps/remote/test/responses-capability-probe.test.ts`

- [ ] Probe a minimal streamed response and require a formal Responses terminal event instead of treating `[DONE]` as completion.
- [ ] Probe a forced no-side-effect function call and its `function_call_output` continuation to prove the endpoint supports the complete agent tool loop.
- [ ] Probe `reasoning.effort` values `low`, `medium`, `high`, and `xhigh` independently. Treat only a completed/incomplete Responses stream as acceptance; map accepted values to `fast`, `balanced`, `deep`, and `max` respectively.
- [ ] Persist the explicit mapping in the test result and pass it to `ResponsesApiProvider`; dynamic installations must not use `officialReasoningPreset(modelName)` as their source of truth.
- [ ] Bound each request with an AbortSignal, a small output limit, no retries, `store:false`, and safe error mapping.
- [ ] Test two mock endpoints using the same model ID but different accepted efforts. Assert one exposes four profiles and the other exposes only its actual subset, proving the result is endpoint-specific rather than model-name or host-name hardcoding.
- [ ] Run the probe, Provider, and tool-loop test suites.

### Task 4: Persistent admission service and dynamic provider catalog

**Files:**
- Create: `apps/remote/src/model/model-admission-repository.ts`
- Create: `apps/remote/src/model/model-admission-service.ts`
- Create: `apps/remote/src/model/model-admission-routes.ts`
- Modify: `apps/remote/src/model/model-student-catalog.ts`
- Test: `apps/remote/test/model-admission-service.test.ts`

- [ ] Store ProviderConnection and ModelStudent records in separate `AtomicJsonStore` documents; only the internal connection record may contain a generated Keychain reference.
- [ ] Keep successful test credentials in an in-memory TTL vault until install. Persist test facts without the Key.
- [ ] On install, write the Key to Keychain, persist records atomically, instantiate `ResponsesApiProvider` with the exact probed reasoning mapping, register it in the catalog, and return only `ModelStudentSummary`.
- [ ] On startup, restore every managed record from disk, resolve its Key only at request time, and register it without hardcoding endpoint or model names.
- [ ] On delete, unregister the provider, remove its ModelStudent/connection records, and delete the Keychain entry; protect the built-in Ollama student.
- [ ] Add `POST /model-student-tests`, `GET /model-student-tests/:id`, `POST /model-students`, and managed `DELETE /model-students/:id` routes.
- [ ] Test restart restoration, expired tests, install rollback when Keychain/persistence fails, public redaction, deletion, and two different fake endpoints.

### Task 5: Resolve the selected provider for every Session and Turn

**Files:**
- Modify: `apps/remote/src/capability/runtime-capability-resolver.ts`
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/src/acp/kindergarten-agent.ts`
- Modify: `apps/remote/src/session/session-binding-service.ts`
- Modify: `apps/remote/src/index.ts`
- Test: `apps/remote/test/runtime/runtime-capability-resolver.test.ts`
- Test: `apps/remote/test/acp-session.test.ts`

- [ ] Replace the single-provider equality check with catalog lookup by `scope.modelStudentId`; retain the built-in Ollama provider as the default for existing tests and internal worksheets.
- [ ] Generate ACP `thought_level` options from the selected Session's registered provider capability, not `runtime.model`.
- [ ] Preserve Session's fixed `modelStudentId`, Turn reasoning snapshots, provider opaque continuation boundaries, token usage, and cross-provider continuation rejection.
- [ ] Verify a Session bound to the managed Responses student produces a Turn through that provider while an Ollama Session continues using Ollama.
- [ ] Verify changing to `max` produces native `{ effort: "xhigh" }` only when the installed endpoint probe accepted `xhigh`; unsupported values must be rejected by ACP before a model request.
- [ ] Run Remote typecheck and the complete Remote suite.

### Task 6: Production model admission page

**Files:**
- Create: `apps/web/src/product/ModelAdmissionPage.tsx`
- Modify: `apps/web/src/api/control-api.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/product/HomePage.tsx`
- Modify: `apps/web/src/product/MePage.tsx`
- Modify: `apps/web/src/product/product.css`
- Test: `apps/web/src/product/model-admission-state.test.ts`

- [ ] Register `/models/new` without mounting the ACP chat owner.
- [ ] Add entry points from the Home “新模型入园” action and “我的 Models”.
- [ ] Build a beginner-oriented custom Responses form with display name, Base URL, model ID, password API Key input, a concise explanation of ownership/cost, and an advanced protocol summary fixed to Responses.
- [ ] Implement `editing -> testing -> verified -> installing -> ready|failed`; editing any connection field invalidates the prior test.
- [ ] Show real probe stages and facts next to the form: streaming, tool loop, usage, reasoning summary, accepted native efforts, and product choices. Never claim an untested feature.
- [ ] Clear the Key field and component state after successful installation or unmount; never use localStorage/sessionStorage, URL parameters, analytics, or console logging for credentials.
- [ ] After installation, navigate to Home with the new student selected and expose only its discovered reasoning choices.
- [ ] Add responsive and accessible form/error/loading styles that reuse the production warm-neutral design.
- [ ] Run Web tests, typecheck, and build.

### Task 7: Full regression and real browser verification

**Files:**
- Modify: `docs/MODEL_ADMISSION.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DEMO_TO_PRODUCTION_REQUIREMENTS_AND_GAPS.md`
- Modify: `AGENTS.md`

- [ ] Update documents to mark custom Responses admission implemented while leaving SiliconFlow and other protocols out of scope.
- [ ] Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check`; preserve all pre-existing uncommitted work and do not commit without the user's request.
- [ ] Restart only the affected local services after tests pass and verify health plus the production route.
- [ ] With Computer Use, enter the user-authorized Base URL, model ID, and API Key into `/models/new`, test the endpoint, install it as `大聪明`, and confirm it appears in Home and “我的 Models”. Credential entry is a confirmation-required action and must pause immediately before transmission.
- [ ] Create a real Session with `大聪明`, inspect available levels, select the product `max` choice, and verify the persisted Turn snapshot records native `reasoning.effort = xhigh`; switch to another accepted level and verify a second snapshot.
- [ ] Run a second endpoint-shaped mock with a reduced effort set and confirm the same page exposes only the reduced set. This is the final non-hardcoding acceptance check.

## Self-review

- Every user-visible capability is derived from a probe record tied to the connection, not the display name, model ID, or host.
- Browser, public contracts, Session history, Context Summary, Evaluation Trace, logs, and Git contain no API Key or credential reference.
- Browser-to-Remote chat remains ACP-only; the localhost Control API is used only for model management, matching existing Agent/Skill/MCP management boundaries.
- Existing Ollama sessions and the built-in ModelStudent remain functional and protected.
- This plan intentionally implements only custom OpenAI Responses-compatible endpoints; SiliconFlow Chat Completions remains a separate adapter and is not implied by this page.
