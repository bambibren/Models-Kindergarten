# Default Agent Build PPTX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every system default Agent enable `build_pptx` by default, migrate an existing default Agent only when that binding is absent, and publish the verified runtime to `modelskindergarten.fun`.

**Architecture:** Add `build_pptx` to the default Agent input assembled at Remote startup. Extend `AgentService.ensureDefault` for the current account, and run an atomic startup migration across every persisted `system_default` record so inactive accounts are upgraded too. Only absent bindings are added; an explicit `enabled: false` choice is preserved. Keep execution inside the existing `PptxToolProvider` and ToolRuntime; do not expose `run_command` or relax `FileSandbox`.

**Tech Stack:** TypeScript, Vitest, pnpm, Docker Buildx, GHCR, Docker Compose, SSH cloud deployment.

---

### Task 1: Lock the existing-default migration behavior with tests

**Files:**
- Modify: `apps/remote/test/agent/agent-service.test.ts`

- [ ] **Step 1: Add a failing migration test**

Add a test that creates a system default Agent with `read_file`, calls `ensureDefault` again with both `read_file` and `build_pptx`, and expects the same Agent ID plus this binding:

```ts
{ toolId: "build_pptx", enabled: true, permission: "allow" }
```

- [ ] **Step 2: Add an explicit-disable preservation assertion**

Update the same Agent so `build_pptx` is present with `enabled: false`, call `ensureDefault` again, and assert it remains disabled. Missing means “not yet migrated”; present-and-disabled means “user choice”.

- [ ] **Step 3: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @kindergarten/remote test -- agent/agent-service.test.ts
```

Expected: the new test fails because `ensureDefault` currently returns an existing record unchanged.

### Task 2: Enable and migrate the default binding

**Files:**
- Modify: `apps/remote/src/agent/agent-repository.ts`
- Modify: `apps/remote/src/agent/agent-service.ts:35-59`
- Modify: `apps/remote/src/index.ts:204-218`

- [ ] **Step 1: Merge only absent default built-in bindings**

After `ensureSystemDefault`, atomically update the record only when one or more bindings from validated default input are absent. Compute absence by `toolId`; do not overwrite an existing binding or its permission:

```ts
const existing = new Set(current.builtinTools.map((item) => item.toolId));
const additions = input.builtinTools.filter((item) => !existing.has(item.toolId));
if (additions.length === 0) return current;
return {
  ...current,
  builtinTools: [...current.builtinTools, ...additions]
    .toSorted((left, right) => left.toolId.localeCompare(right.toolId)),
  updatedAt: new Date().toISOString(),
};
```

- [ ] **Step 2: Put `PPTX_TOOL_IDS` in the system default Agent input**

Change the default tool list to:

```ts
[
  ...new ToolRegistry(sandbox).definitions.map((item) => item.function.name),
  ...ARTIFACT_TOOL_IDS,
  ...PPTX_TOOL_IDS,
]
```

- [ ] **Step 3: Migrate every persisted system default at startup**

Add an atomic repository migration that visits every `recordKind: "system_default"` record, appends only missing default tool bindings, and leaves ordinary Agents and existing bindings untouched. Invoke it before the local startup default is ensured, so accounts that have not opened the Agent management route are also upgraded.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
pnpm --filter @kindergarten/remote test -- agent/agent-service.test.ts runtime/runtime-capability-resolver.test.ts pptx/pptx-tool-provider.test.ts
```

Expected: all focused tests pass, including the existing rule that `build_pptx` only enters a Turn snapshot when enabled.

### Task 3: Verify the repository and build artifacts

**Files:**
- Verify only: repository-wide TypeScript, tests, and build output

- [ ] **Step 1: Run the complete check**

Run:

```bash
CI=true pnpm check
```

Expected: typecheck, all tests, and all workspace builds pass.

- [ ] **Step 2: Review the diff and confirm the boundary**

Run:

```bash
git diff --check
git diff -- apps/remote/src/index.ts apps/remote/src/agent/agent-service.ts apps/remote/test/agent/agent-service.test.ts
```

Expected: no whitespace errors; no change to ACP, FileSandbox, permissions, secrets, or `run_command` exposure.

- [ ] **Step 3: Commit the verified source change**

Run:

```bash
git add apps/remote/src/index.ts apps/remote/src/agent/agent-service.ts apps/remote/test/agent/agent-service.test.ts docs/superpowers/plans/2026-08-30-default-agent-build-pptx.md
git commit -m "feat: enable pptx builds for default agents"
```

Expected: a clean commit whose short SHA can identify the release.

### Task 4: Build and publish the production runtime image

**Files:**
- Create: `deploy/releases/2026-08-30-<short-sha>/release-manifest.json`

- [ ] **Step 1: Build and push the runtime image for Linux AMD64**

Run with the committed short SHA as the immutable tag:

```bash
docker buildx build --platform linux/amd64 --file deploy/images/Dockerfile.runtime --tag ghcr.io/bambibren/models-kindergarten/mk-runtime:<short-sha> --push .
```

Expected: GHCR push succeeds and reports a `sha256:` manifest digest.

- [ ] **Step 2: Create a digest-pinned release manifest**

Create a schema version 1 manifest using the new runtime digest and the currently deployed digest-pinned Web and ONLYOFFICE images. Set `gitCommit` to the full source commit and `release` to `2026-08-30-<short-sha>`.

- [ ] **Step 3: Validate the manifest through a dry run**

Run:

```bash
pnpm deploy:cloud:domain -- --server zhanglei234 --domain modelskindergarten.fun --office-domain office.modelskindergarten.fun --manifest deploy/releases/2026-08-30-<short-sha>/release-manifest.json --confirm-production-ready --dry-run
```

Expected: the generated SSH/SCP deployment commands use only digest-pinned images and the intended domains.

### Task 5: Deploy and verify production

**Files:**
- Verify only: `/srv/mk/current`, Docker containers, `/data/agents.json`, public health endpoints

- [ ] **Step 1: Deploy the domain release**

Run:

```bash
pnpm deploy:cloud:domain -- --server zhanglei234 --domain modelskindergarten.fun --office-domain office.modelskindergarten.fun --manifest deploy/releases/2026-08-30-<short-sha>/release-manifest.json --confirm-production-ready
```

Expected: Compose pull/up, internal-origin probes, and public readiness probe all pass before `/srv/mk/current` switches.

- [ ] **Step 2: Verify runtime health and release identity**

Confirm `/srv/mk/current` resolves to the new release, `mk-mk-app-1` is healthy, restart count is zero, and `https://modelskindergarten.fun/health/ready` returns success.

- [ ] **Step 3: Verify the existing production system default Agent migrated**

Read only the target Agent record from `/data/agents.json` and assert it contains:

```json
{"toolId":"build_pptx","enabled":true,"permission":"allow"}
```

- [ ] **Step 4: Verify the runtime capability path**

Confirm the deployed bundle contains `build_pptx`, and verify a subsequent Turn for the same default Agent exposes `pptx:tool:build_pptx` in its capability snapshot. Do not mutate or replay the already completed historical Turn.
