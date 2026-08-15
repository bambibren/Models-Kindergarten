# Manual ACP Session Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an active Turn running when its WebSocket disconnects, let the user manually resume it with missing current-Turn output, and map Stop/leave actions to ACP cancel/close while removing the 24-model-request cap.

**Architecture:** The Remote owns the Turn lifetime independently from a WebSocket request. A session-scoped ACP channel swaps to the client supplied by `session/resume`; persisted Session entries and the in-memory active projection provide the current-Turn snapshot. Resume metadata carries per-message text offsets and next chunk indexes so the Remote sends only missing text plus idempotent non-text snapshots. The Web never reconnects automatically.

**Tech Stack:** TypeScript, React, Zustand, ACP SDK 1.3, Vitest, WebSocket.

---

### Task 1: Remove the model-round ceiling

**Files:**
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/test/runtime.test.ts`

- [x] Delete `DEFAULT_MAX_MODEL_ROUNDS`, the constructor parameter, and the `TURN_MODEL_ROUND_LIMIT` branch.
- [x] Remove the obsolete finite-loop test and keep repeated-invalid-tool-call guard tests unchanged except for constructor argument positions.
- [x] Run the Remote Runtime tests and confirm all remaining Runtime tests pass.

### Task 2: Define and test the resume cursor

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/session-resume.ts`
- Create: `packages/contracts/src/session-resume.test.ts`
- Create: `apps/web/src/chat/chat-resume.ts`
- Create: `apps/web/src/chat/chat-resume.test.ts`

- [x] Add a versioned `SessionResumeMeta` contract containing `turnId` and message/thought cursors `{ textLength, nextChunkIndex }`.
- [x] Add strict parsing tests for valid offsets and rejection of negative/non-integer cursor values.
- [x] Add a pure Web projection helper that derives the resume cursor from the current streaming Turn without mutating Chat state.
- [x] Test that received text length and the next unused chunk index are derived independently for each message and thought.

### Task 3: Decouple the active Turn from one ACP connection

**Files:**
- Create: `apps/remote/src/acp/session-acp-channel.ts`
- Modify: `apps/remote/src/acp/acp-output.ts`
- Modify: `apps/remote/src/acp/kindergarten-agent.ts`
- Modify: `apps/remote/test/acp-session.test.ts`
- Modify: `apps/remote/test/websocket.test.ts`

- [x] Add a session channel that can attach/detach an ACP client, drop failed live projections, and wait for a replacement client only when a reverse request needs user input.
- [x] Stop linking the prompt request AbortSignal to the Runtime AbortController; use it only to detach the dead client.
- [x] Make `session/resume` attach the replacement client, replay missing text for the requested Turn, replay idempotent tool/context/usage snapshots, and publish the authoritative Turn state.
- [x] Keep `session/load` as complete history replay and `session/close` as cancel plus channel cleanup.
- [x] Test disconnect-while-running, background completion, resume delta, explicit cancel, and explicit close over both in-memory ACP and a real WebSocket.

### Task 4: Add manual reconnect and normal close behavior in Web

**Files:**
- Modify: `apps/web/src/acp/acp-client.ts`
- Modify: `apps/web/src/App.tsx`

- [x] Add `closeSession()` and cursor-aware `resume()` methods to the single ACP connection owner.
- [x] On unexpected socket close, set connection state to disconnected but leave the Turn and partial stream active.
- [x] Make the existing reconnect button open one new connection and call `session/resume`; do not reload the page and do not schedule automatic retries.
- [x] Commit streaming entries when the resumed authoritative Turn state is terminal.
- [x] Send `session/cancel` from Stop without closing the socket or Session.
- [x] Await `session/close` before normal in-app navigation, and attempt it from `pagehide` before closing the transport.
- [x] Run Web tests/typecheck and Remote tests/typecheck; then run repository-wide typecheck, test, and build successfully.
