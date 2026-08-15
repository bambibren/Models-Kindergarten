# Skill Git Operation Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Skill discovery and installation from remaining pending when a Git checkout or revision lookup stalls.

**Architecture:** Centralize every Git subprocess used by Skill installation behind one execution helper. Resolve the macOS proxy once per workflow, pass the same environment to clone, checkout, and revision lookup, and apply bounded timeouts to every network-capable Git operation so errors propagate through the existing Tool and Turn state machines.

**Tech Stack:** TypeScript, Node.js `child_process.execFile`, Vitest, Remote ACP runtime.

---

### Task 1: Specify bounded Git execution

**Files:**
- Modify: `apps/remote/src/skills/skill-installer.ts`
- Test: `apps/remote/test/skills/skill-installation.test.ts`

- [x] **Step 1: Add failing tests**

Add tests around an exported Git-operation options builder. Verify that the resolved proxy environment is preserved and that checkout receives a finite timeout and non-interactive Git configuration.

- [x] **Step 2: Run the focused test**

Run: `pnpm --filter @kindergarten/remote test -- test/skills/skill-installation.test.ts`

Expected: the new expectations fail before implementation.

- [x] **Step 3: Centralize Git subprocess options**

Resolve the proxy environment once in each discovery or installation workflow. Pass it to clone, checkout, and `rev-parse`; set `GIT_TERMINAL_PROMPT=0` even when no proxy is present; give checkout a finite timeout because partial-clone checkout can fetch missing blobs.

- [x] **Step 4: Preserve error propagation**

Do not catch a timed-out checkout as success and do not create an installation record. Let the existing installation service translate the failure so ToolRuntime records a failed Tool Call and the Turn reaches its terminal failed state.

### Task 2: Verify runtime behavior

**Files:**
- Verify: `apps/remote/src/skills/skill-installation-service.ts`
- Verify: `apps/remote/src/tools/tool-runtime.ts`

- [x] **Step 1: Run focused tests**

Run: `pnpm --filter @kindergarten/remote test -- test/skills/skill-installation.test.ts test/tool-loop.test.ts`

Expected: all selected tests pass.

- [x] **Step 2: Run Remote validation**

Run: `pnpm --filter @kindergarten/remote typecheck && pnpm --filter @kindergarten/remote test`

Expected: typecheck succeeds and all Remote tests pass.

- [x] **Step 3: Restart and health-check Remote**

Restart only the service listening on port 7331. Verify `http://127.0.0.1:7331/health` and `http://127.0.0.1:5174/` both return HTTP 200.

- [x] **Step 4: Re-run a real bounded discovery**

Exercise the same `nexu-io/open-design` source through the installer or a new conversation. Confirm it either completes or fails within the configured bound and never remains pending indefinitely.
