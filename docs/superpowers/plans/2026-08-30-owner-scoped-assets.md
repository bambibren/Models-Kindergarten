# Owner-Scoped Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 保证 Agent、ModelStudent、Skill、MCP、Session、Artifact 与 Experiment 的所有引用都属于当前登录账号，且删除、卸载和历史引用不会制造悬空或跨账号引用。

**Architecture:** 以 `ownerId` 作为所有业务资产的统一安全边界；创建引用时由拥有目标资产的服务校验，运行时再次验证 Session 绑定。Agent 能力候选改为按 owner 异步解析，并在账号首次读取 Agent 时清理旧的悬空 Skill/MCP 引用。共享 Skill 文件采用引用计数语义，最后一个账号卸载后才删除物理目录。

**Tech Stack:** TypeScript、Node.js ESM、AtomicJsonStore、Vitest、ACP、React Control API。

---

### Task 1: Agent 能力引用按账号隔离

**Files:**
- Modify: `apps/remote/src/agent/agent-service.ts`
- Modify: `apps/remote/src/agent/agent-routes.ts`
- Modify: `apps/remote/src/index.ts`
- Test: `apps/remote/test/agent/agent-service.test.ts`
- Test: `apps/remote/test/agent/agent-routes.test.ts`

- [x] **Step 1: 写跨账号 Skill/MCP 引用失败测试**

```ts
await expect(service.create(inputWithSkill("skill-owner-a"), "owner-b"))
  .rejects.toThrow("Skill Installation 不可用");
await expect(service.create(inputWithMcp("mcp-owner-a"), "owner-b"))
  .rejects.toThrow("MCP Installation 不可用");
```

- [x] **Step 2: 运行测试并确认旧实现错误接受全局 ID**

Run: `pnpm --filter @kindergarten/remote test -- agent/agent-service.test.ts agent/agent-routes.test.ts`
Expected: FAIL，跨账号引用被接受或 capability options 泄露其他账号资产。

- [x] **Step 3: 将能力源和 Agent 校验改为 owner-scoped async**

```ts
interface AgentCapabilitySource {
  builtinToolIds(): string[];
  readySkillInstallationIds(ownerId: string): Promise<string[]>;
  mcpCapabilities(ownerId: string): Promise<Array<{ installationId: string; tools: string[]; resources: string[] }>>;
}
```

`create`、`update`、`ensureDefault`、`createExperimentPolicy`、`mergeReadySkills`、`capabilityOptions` 和上下文策略校验都必须传入 `ownerId` 并等待校验结果。

- [x] **Step 4: 默认 Agent 只绑定当前账号已拥有的 Skill**

```ts
const defaultAgentInput = async (ownerId: string): Promise<AgentInput> => {
  const owned = await skillInstallations.list(ownerId);
  return { ...baseDefaultAgentInput(), skillInstallationIds: owned.filter(isConfiguredReadySkill).map(idOf) };
};
```

- [x] **Step 5: 运行 Agent 测试**

Run: `pnpm --filter @kindergarten/remote test -- agent/agent-service.test.ts agent/agent-routes.test.ts`
Expected: PASS，两个账号只能看到并绑定自己的 Skill/MCP。

### Task 2: ModelStudent、Session、Experiment 与 Artifact 引用按账号校验

**Files:**
- Modify: `apps/remote/src/model/model-admission-service.ts`
- Modify: `apps/remote/src/session/session-launch-service.ts`
- Modify: `apps/remote/src/capability/runtime-capability-resolver.ts`
- Modify: `apps/remote/src/experiments/experiment-service.ts`
- Modify: `apps/remote/src/index.ts`
- Test: `apps/remote/test/session/session-launch-service.test.ts`
- Test: `apps/remote/test/runtime/runtime-capability-resolver.test.ts`
- Test: `apps/remote/test/experiments/experiment-service.test.ts`

- [x] **Step 1: 写跨账号模型和 Artifact 绑定失败测试**

```ts
await expect(launches.create({ modelStudentId: "model-a", agentId: "agent-b", promptText: "hi" }, "owner-b"))
  .rejects.toThrow("ModelStudent 不可用");
await expect(launches.create({ ...valid, artifactMentions: [{ artifactId: "artifact-a" }] }, "owner-b"))
  .rejects.toThrow("Artifact");
```

- [x] **Step 2: 增加唯一的 owner-aware 模型就绪检查**

```ts
async isReady(modelStudentId: string, ownerId: string): Promise<boolean> {
  return this.get(modelStudentId, ownerId).then((item) => item.status === "ready", () => false);
}
```

Session Launch、Runtime Resolver、Session Binding 和 Experiment Draft 全部复用此检查，禁止直接使用全局 Catalog 的 `isReady()` 作为账号授权判断。

- [x] **Step 3: Session Launch 在保存草稿前解析 Artifact mentions**

```ts
if (artifactMentions.length > 0) {
  await artifacts.resolveMentions(artifactMentions.map((item) => item.artifactId), ownerId);
}
```

- [x] **Step 4: 运行 Session、Runtime、Experiment 测试**

Run: `pnpm --filter @kindergarten/remote test -- session/session-launch-service.test.ts runtime/runtime-capability-resolver.test.ts experiments/experiment-service.test.ts`
Expected: PASS，跨账号 ModelStudent/Artifact/Agent 绑定均被拒绝。

### Task 3: 清理悬空 Agent 引用并保护共享 Skill 文件

**Files:**
- Modify: `apps/remote/src/agent/agent-service.ts`
- Modify: `apps/remote/src/skills/skill-installation-service.ts`
- Test: `apps/remote/test/agent/agent-service.test.ts`
- Test: `apps/remote/test/skills/skill-installation.test.ts`

- [x] **Step 1: 写旧 Agent 悬空引用修复测试**

```ts
const repaired = await service.reconcileCapabilities("owner-b");
expect(repaired[0]?.skills).toEqual([]);
expect(repaired[0]?.mcps).toEqual([]);
```

- [x] **Step 2: 在账号 Agent 列表入口执行显式修复**

修复只删除不属于该 owner 或已不可用的 Skill/MCP binding，不改变 System Prompt、Builtin Tool、历史 Session 或模型绑定，并记录受影响 Agent ID。

- [x] **Step 3: 写共享 Skill 卸载测试**

```ts
await service.uninstall(ownerAInstallationId, "owner-a");
expect(installer.uninstall).not.toHaveBeenCalled();
await service.uninstall(ownerBInstallationId, "owner-b");
expect(installer.uninstall).toHaveBeenCalledWith("pptx");
```

- [x] **Step 4: 最后一个引用删除后才卸载物理 Skill**

检查 Repository 中其他 owner 的同名 ready installation；仍有引用时只删除当前 owner 的安装记录和 Agent binding。

- [x] **Step 5: 运行 Agent 与 Skill 测试**

Run: `pnpm --filter @kindergarten/remote test -- agent/agent-service.test.ts skills/skill-installation.test.ts`
Expected: PASS，旧脏数据可修复且共享 Skill 不被提前删除。

### Task 4: 账号删除覆盖 MCP 运行配置与引用数据

**Files:**
- Modify: `apps/remote/src/auth/account-data-deletion-service.ts`
- Test: `apps/remote/test/auth/auth-user-cli.test.ts`

- [x] **Step 1: 写删除账号后 MCP 配置不得残留的测试**

```ts
await deletion.deleteOwner("owner-a");
expect(readMcpConfig().servers.map((item) => item.id)).not.toContain("mcp-owner-a");
expect(readMcpConfig().servers.map((item) => item.id)).toContain("mcp-owner-b");
```

- [x] **Step 2: 删除 owner 记录前收集 MCP Installation ID 并清理配置**

只移除属于目标 owner 的 MCP server 配置；保留其他账号、系统内置 MCP、Secret 和所有共享 Blob。

- [x] **Step 3: 运行账号删除测试**

Run: `pnpm --filter @kindergarten/remote test -- auth/auth-user-cli.test.ts`
Expected: PASS，登录记录、业务资产、MCP 配置和账号 Session 一并清理。

### Task 5: 全量验证与生产数据修复准备

**Files:**
- Modify: `docs/superpowers/plans/2026-08-30-owner-scoped-assets.md`

- [x] **Step 1: 运行 Remote 全量测试**

Run: `pnpm --filter @kindergarten/remote test`
Expected: PASS。

- [x] **Step 2: 运行仓库类型检查和构建**

Run: `pnpm typecheck && pnpm build`
Expected: PASS。

- [x] **Step 3: 检查生产数据兼容性**

验证已有 `agents.json`、`skill-installations.json`、`mcp-installations.json`、Session 分片和模型目录无需 Schema 迁移；账号下次读取 Agent 列表时会原子清理悬空 capability binding。

- [x] **Step 4: 提交代码但不自动部署**

```bash
git add apps/remote packages/contracts docs/superpowers/plans/2026-08-30-owner-scoped-assets.md
git commit -m "fix: enforce owner-scoped asset references"
```

Expected: 工作区仅保留用户原有改动；部署由明确的发布步骤继续执行。
