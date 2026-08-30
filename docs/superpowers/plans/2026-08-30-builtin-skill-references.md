# Builtin Skill Stable References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把随 MK 镜像发布的 Builtin Skills 从账号所属的 Skill Installation 中分离，改为所有账号共享的稳定 `builtin:<name>` 引用，同时迁移现有 `sandbox-notes` 数据且保留用户安装 Skill 的 owner 隔离。

**Architecture:** JoyCode 的 Bundled Skills 在启动时注册进全局目录，使用名称直接解析，不生成用户安装记录；MK 采用同一原则，但保留现有 Agent 配置能力：`AgentRecord.builtinSkills` 保存全局固定引用，`AgentRecord.skills` 继续只保存账号所属的 Installation UUID。Runtime 分别解析两类引用后合并为允许加载的 Skill 名称；启动迁移把旧 Builtin Installation 引用转换成固定引用并删除伪安装记录。

**Tech Stack:** TypeScript 7、Node.js ESM、React、Vitest、原子 JSON 持久化、pnpm monorepo

---

## File Structure

- Modify: `packages/contracts/src/agent-management.ts` — 定义 Builtin Skill 绑定与 Agent 输入合同。
- Modify: `packages/contracts/src/experiments.ts` — 让 Context Experiment 保存同一份 Builtin Skill 策略。
- Modify: `packages/contracts/src/management-contracts.test.ts` — 锁定解析、去重和容量行为。
- Modify: `apps/remote/src/skills/skill-registry.ts` — 生成并解析稳定 `builtin:<name>` ID。
- Modify: `apps/remote/src/skills/skill-installation-service.ts` — 停止为 Builtin Skill 创建 Installation，并迁移旧记录。
- Modify: `apps/remote/src/agent/agent-repository.ts` — 原子迁移所有 Agent 的旧引用。
- Modify: `apps/remote/src/agent/agent-service.ts` — 校验、保存、修复 Builtin 与 Installed 两类 Skill。
- Modify: `apps/remote/src/capability/runtime-capability-resolver.ts` — 合并两类引用后向 Runtime 提供 Skill 名称。
- Modify: `apps/remote/src/index.ts` — 启动迁移、默认 Agent 配给与能力选项接线。
- Modify: `apps/remote/src/session/session-routes.ts` — 历史上下文策略返回 Builtin Skill 引用。
- Modify: `apps/remote/src/repository/session-types.ts` — 快照持久化 Builtin Skill 绑定。
- Modify: `apps/remote/src/runtime/agent-runtime.ts` — Turn 快照复制新增字段。
- Modify: `apps/remote/src/experiments/*` — 实验策略、冻结快照和预览传递新增字段。
- Modify: `apps/web/src/product/AgentPolicyFields.tsx` — 展示共享 Builtin Skills 与账号安装 Skills。
- Modify: `apps/web/src/product/AgentEditorPage.tsx` — 编辑状态映射新增字段。
- Modify: `apps/web/src/product/context-lab-state.ts` — Context Lab 保留 Builtin Skill 策略。
- Modify: corresponding `apps/remote/test/**` and `apps/web/src/**/*.test.*` — 回归所有读写与迁移路径。
- Modify: `docs/ARCHITECTURE.md` — 用当前架构事实说明两类 Skill 引用。

### Task 1: Extend the Agent and Experiment contracts

**Files:**
- Modify: `packages/contracts/src/agent-management.ts`
- Modify: `packages/contracts/src/experiments.ts`
- Test: `packages/contracts/src/management-contracts.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add assertions that input accepts, deduplicates, and sorts fixed Builtin Skill IDs independently from Installation UUIDs:

```ts
const parsed = parseAgentInput({
  ...baseInput,
  builtinSkillIds: ["builtin:sandbox-notes", "builtin:sandbox-notes"],
  skillInstallationIds: ["install-b", "install-a"],
});
expect(parsed.builtinSkillIds).toEqual(["builtin:sandbox-notes"]);
expect(parsed.skillInstallationIds).toEqual(["install-a", "install-b"]);
```

Also assert that an ID without the `builtin:` namespace is rejected.

- [ ] **Step 2: Run the focused contract test and verify failure**

Run: `pnpm --filter @kindergarten/contracts test -- management-contracts.test.ts`

Expected: FAIL because `builtinSkillIds` is not part of `AgentInput`.

- [ ] **Step 3: Add explicit Builtin Skill contracts**

Define and thread these fields through parsing and canonicalization:

```ts
export interface BuiltinSkillBinding {
  skillId: string;
  enabled: boolean;
}

export interface BuiltinSkillOption {
  skillId: string;
  name: string;
  description: string;
}

export interface AgentInput {
  // existing fields
  builtinSkillIds: string[];
  skillInstallationIds: string[];
}

export interface AgentRecord extends Omit<AgentInput, "builtinSkillIds" | "skillInstallationIds"> {
  // existing fields
  builtinSkills: BuiltinSkillBinding[];
  skills: SkillBinding[];
}
```

Require the `builtin:` prefix, apply one combined `maxAgentSkills` limit to Builtin plus Installed selections, and add `builtinSkillIds` to `ExperimentContextPolicy` and V2 experiment parsing.

- [ ] **Step 4: Run contract tests**

Run: `pnpm --filter @kindergarten/contracts test`

Expected: PASS.

- [ ] **Step 5: Commit the contract change**

```bash
git add packages/contracts/src/agent-management.ts packages/contracts/src/experiments.ts packages/contracts/src/management-contracts.test.ts
git commit -m "refactor: model builtin skill references"
```

### Task 2: Give Builtin Skills stable Registry identities

**Files:**
- Modify: `apps/remote/src/skills/skill-registry.ts`
- Test: `apps/remote/test/skills/skill-registry.test.ts`

- [ ] **Step 1: Write failing Registry tests**

Cover stable identity, filtering, and rejection:

```ts
expect(registry.builtinOptions()).toContainEqual(expect.objectContaining({
  skillId: "builtin:sandbox-notes",
  name: "sandbox-notes",
}));
expect(registry.builtinNames(["builtin:sandbox-notes"])).toEqual(["sandbox-notes"]);
expect(() => registry.builtinNames(["builtin:missing"])).toThrow("Builtin Skill 不存在");
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @kindergarten/remote test -- skill-registry.test.ts`

Expected: FAIL because the new Registry methods do not exist.

- [ ] **Step 3: Implement stable Builtin IDs**

Use one namespace helper and resolve only records with `scope === "builtin"`:

```ts
export function builtinSkillId(name: string): string {
  return `builtin:${name}`;
}

builtinOptions(): BuiltinSkillOption[] {
  return this.all()
    .filter((skill) => skill.scope === "builtin")
    .map((skill) => ({
      skillId: builtinSkillId(skill.name),
      name: skill.name,
      description: skill.description,
    }));
}
```

`builtinNames()` must reject non-Builtin IDs and missing Registry records instead of silently dropping them.

- [ ] **Step 4: Run Registry tests**

Run: `pnpm --filter @kindergarten/remote test -- skill-registry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Registry identity support**

```bash
git add apps/remote/src/skills/skill-registry.ts apps/remote/test/skills/skill-registry.test.ts
git commit -m "feat: add stable builtin skill identities"
```

### Task 3: Stop creating Builtin Installations and migrate old data

**Files:**
- Modify: `apps/remote/src/skills/skill-installation-service.ts`
- Modify: `apps/remote/src/agent/agent-repository.ts`
- Modify: `apps/remote/src/agent/agent-service.ts`
- Test: `apps/remote/test/skills/skill-installation.test.ts`
- Test: `apps/remote/test/agent/agent-service.test.ts`

- [ ] **Step 1: Write failing migration tests**

Create two accounts whose Agents both reference the same legacy Builtin Installation UUID. After migration assert:

```ts
expect(ownerAAgent.builtinSkills).toEqual([
  { skillId: "builtin:sandbox-notes", enabled: true },
]);
expect(ownerBAgent.builtinSkills).toEqual([
  { skillId: "builtin:sandbox-notes", enabled: true },
]);
expect(ownerAAgent.skills).toEqual([]);
expect(ownerBAgent.skills).toEqual([]);
expect(await installations.list("local-admin")).toEqual([]);
```

Add a separate assertion that a user-installed Skill remains owner-scoped and unchanged.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @kindergarten/remote test -- skill-installation.test.ts agent-service.test.ts`

Expected: FAIL because Builtin Installation records are still created and Agent has no `builtinSkills` field.

- [ ] **Step 3: Add an atomic Agent migration operation**

Add a repository operation that rewrites every record in one store update:

```ts
async migrateBuiltinSkills(byInstallationId: ReadonlyMap<string, string>): Promise<AgentRecord[]> {
  return (await this.store.update((records) => {
    const migrated = records.map((record) => migrateAgentBuiltinSkills(record, byInstallationId));
    return { records: migrated, result: migrated };
  })) ?? [];
}
```

The migration must preserve `enabled`, deduplicate fixed IDs, initialize missing `builtinSkills` to `[]`, remove only mapped entries from `skills`, and never change owner, prompt, MCP, timestamps, or user Installation bindings.

- [ ] **Step 4: Make Installation import exclude Builtin Skills**

In `importExisting()`, do not create Installation records for `scope === "builtin"`. Add a startup migration method that:

1. finds persisted records whose source is `{ kind: "builtin" }`;
2. maps each Installation UUID to `builtin:<skillName>` after Registry validation;
3. invokes the atomic Agent migration once;
4. deletes only those Builtin Installation records;
5. removes their IDs from the in-memory ready set.

Project and user Skill behavior must remain unchanged.

- [ ] **Step 5: Update Agent validation and reconciliation**

Agent create/update/default validation must independently check:

```ts
const builtinIds = new Set(this.capabilities.builtinSkills().map((item) => item.skillId));
for (const id of input.builtinSkillIds) {
  if (!builtinIds.has(id)) throw invalid(`Builtin Skill 不存在: ${id}`);
}
```

Reconciliation may remove a Builtin reference only when the fixed ID no longer exists in the Registry; it must continue preserving disabled or temporarily unavailable user Installation records.

- [ ] **Step 6: Run migration and Agent tests**

Run: `pnpm --filter @kindergarten/remote test -- skill-installation.test.ts agent-service.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the migration**

```bash
git add apps/remote/src/skills/skill-installation-service.ts apps/remote/src/agent/agent-repository.ts apps/remote/src/agent/agent-service.ts apps/remote/test/skills/skill-installation.test.ts apps/remote/test/agent/agent-service.test.ts
git commit -m "refactor: migrate builtin skills out of installations"
```

### Task 4: Resolve both Skill classes in Runtime and immutable snapshots

**Files:**
- Modify: `apps/remote/src/capability/runtime-capability-resolver.ts`
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/src/repository/session-types.ts`
- Modify: `apps/remote/src/session/session-routes.ts`
- Modify: `apps/remote/src/experiments/context-preview-service.ts`
- Modify: `apps/remote/src/experiments/experiment-service.ts`
- Modify: `apps/remote/src/experiments/annotation-worksheet-generator.ts`
- Test: `apps/remote/test/runtime/runtime-capability-resolver.test.ts`
- Test: `apps/remote/test/session/session-v4.test.ts`
- Test: `apps/remote/test/experiments/context-preview-service.test.ts`
- Test: `apps/remote/test/experiments/experiment-service.test.ts`

- [ ] **Step 1: Write failing Runtime and snapshot tests**

Assert that a fixed Builtin reference loads `sandbox-notes` without calling `SkillInstallationService.get()`, while an Installation reference still calls owner-scoped resolution. Assert `agentSnapshotHash` changes when `builtinSkills` changes and saved Session/Experiment policies round-trip `builtinSkillIds`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @kindergarten/remote test -- runtime-capability-resolver.test.ts session-v4.test.ts context-preview-service.test.ts experiment-service.test.ts`

Expected: FAIL on missing Builtin fields and unresolved fixed IDs.

- [ ] **Step 3: Merge resolved names at the Runtime boundary**

Resolve both classes before constructing `SkillToolProvider` and context sources:

```ts
const builtinNames = this.skills.builtinNames(
  agent.builtinSkills.filter((item) => item.enabled).map((item) => item.skillId),
);
const installedNames = this.skillInstallations
  ? await this.skillInstallations.runtimeSkillNames(installationIds, scope.ownerId)
  : installationIds;
const skillNames = [...new Set([...builtinNames, ...installedNames])];
```

Include `builtinSkills` in Agent snapshot hashes, persisted Turn snapshots, context-policy responses, and frozen Experiment policies.

- [ ] **Step 4: Run focused Runtime and snapshot tests**

Run: `pnpm --filter @kindergarten/remote test -- runtime-capability-resolver.test.ts session-v4.test.ts context-preview-service.test.ts experiment-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Runtime integration**

```bash
git add apps/remote/src/capability/runtime-capability-resolver.ts apps/remote/src/runtime/agent-runtime.ts apps/remote/src/repository/session-types.ts apps/remote/src/session/session-routes.ts apps/remote/src/experiments packages/contracts/src/experiments.ts apps/remote/test/runtime apps/remote/test/session apps/remote/test/experiments
git commit -m "feat: resolve builtin skills independently at runtime"
```

### Task 5: Wire startup, default Agent, and Web editing

**Files:**
- Modify: `apps/remote/src/index.ts`
- Modify: `apps/remote/src/agent/agent-routes.ts`
- Modify: `apps/web/src/product/AgentPolicyFields.tsx`
- Modify: `apps/web/src/product/AgentEditorPage.tsx`
- Modify: `apps/web/src/product/context-lab-state.ts`
- Test: `apps/remote/test/agent/agent-routes.test.ts`
- Test: `apps/web/src/product/AgentPolicyFields.test.tsx`
- Test: `apps/web/src/product/context-lab-state.test.ts`

- [ ] **Step 1: Write failing API and Web tests**

Assert `/capability-options` returns:

```ts
{
  builtinSkills: [{
    skillId: "builtin:sandbox-notes",
    name: "sandbox-notes",
    description: expect.any(String),
  }],
}
```

Assert the Agent editor checks the Builtin Skill independently from Installed Skills and serializes both fields. Assert the Me page installed-Skills list contains no Builtin record.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @kindergarten/remote test -- agent-routes.test.ts && pnpm --filter @kindergarten/web test -- AgentPolicyFields.test.tsx context-lab-state.test.ts`

Expected: FAIL because the API and form do not expose Builtin Skills.

- [ ] **Step 3: Wire startup in the correct order**

After Registry and Installation service initialization:

```ts
await skillInstallations.importExisting();
await skillInstallations.migrateBuiltinInstallations();
```

Expose `skills.builtinOptions()` through the Agent capability source. Default Agent input must bind the configured Builtin names as stable IDs:

```ts
builtinSkillIds: skills.builtinOptions()
  .filter((item) => capabilityConfig.agentCapabilities.skills.includes(item.name))
  .map((item) => item.skillId),
```

New accounts therefore receive `builtin:sandbox-notes`; existing migrated Agents retain their previous enabled state.

- [ ] **Step 4: Render two Skill sources in one policy section**

Keep one visible “Skills” section but label each option:

```text
sandbox-notes     系统内置
website-design    用户安装
```

Builtin checkboxes update `builtinSkillIds`; Installed checkboxes continue updating `skillInstallationIds`. The “我的 / Skills” asset panel continues listing only installable, deletable account assets.

- [ ] **Step 5: Run API and Web tests**

Run: `pnpm --filter @kindergarten/remote test -- agent-routes.test.ts && pnpm --filter @kindergarten/web test -- AgentPolicyFields.test.tsx context-lab-state.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit startup and UI wiring**

```bash
git add apps/remote/src/index.ts apps/remote/src/agent/agent-routes.ts apps/remote/test/agent/agent-routes.test.ts apps/web/src/product/AgentPolicyFields.tsx apps/web/src/product/AgentEditorPage.tsx apps/web/src/product/context-lab-state.ts apps/web/src/product/AgentPolicyFields.test.tsx apps/web/src/product/context-lab-state.test.ts
git commit -m "feat: expose shared builtin skills to every account"
```

### Task 6: Document and verify the complete repository

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: any compile-failing test fixtures that construct `AgentInput`, `AgentRecord`, or `ExperimentContextPolicy`

- [ ] **Step 1: Update the bounded architecture text**

Add only the implemented distinction:

```text
Skill Registry
├─ Builtin Skill
│  ├─ 固定引用 builtin:<name>
│  ├─ 所有账号共享
│  └─ 不进入 Installation
└─ User Skill
   ├─ Installation UUID
   ├─ ownerId 隔离
   └─ 可安装、停用、卸载
```

- [ ] **Step 2: Run formatting and type checks**

Run: `git diff --check && pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Run all tests**

Run: `pnpm test`

Expected: PASS across contracts, resource, web, and remote workspaces.

- [ ] **Step 4: Build all production artifacts**

Run: `pnpm build`

Expected: PASS; only the pre-existing Vite chunk-size warning is acceptable.

- [ ] **Step 5: Verify migration invariants by search**

Run:

```bash
rg -n 'kind: "builtin"|source\.kind === "builtin"' apps/remote/src/skills/skill-installation-service.ts
rg -n 'builtin:sandbox-notes|builtinSkillIds|builtinSkills' packages/contracts apps/remote/src apps/web/src
```

Expected: Builtin source appears only in migration/Registry handling; active Agent and Runtime paths use stable references. No code creates a Builtin `SkillInstallation`.

- [ ] **Step 6: Commit final documentation and fixture updates**

```bash
git add docs/ARCHITECTURE.md packages apps
git commit -m "docs: describe builtin skill reference architecture"
```

## Self-Review

- Spec coverage: JoyCode comparison, fixed global identity, all-account availability, default Agent binding, owner-scoped user installations, migration, Runtime, Session snapshot, Experiment, Web UI, documentation, and full verification are covered.
- Placeholder scan: no TBD/TODO or unspecified implementation step remains.
- Type consistency: `builtinSkillIds` is the input/policy representation; `builtinSkills` is the persisted Agent/snapshot representation; Installed Skills retain `skillInstallationIds` input and `skills` persisted bindings.
- Scope boundary: MCP ownership, ModelStudent lifecycle, account permissions, deployment, and Skill script execution are unchanged.
