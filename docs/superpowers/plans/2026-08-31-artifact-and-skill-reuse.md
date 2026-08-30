# Artifact 与同名 Skill 复用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让空 `artifact_id` 按未提供处理，并让 `ensure_agent_skills` 在来源不同但 Skill 同名时复用现有安装并绑定 Agent。

**Architecture:** Artifact 层只对 `publish_artifact`/`publish_artifact_version` 的可选 ID 做空白归一化，不放宽其他字符串参数。Skill 层先保留同源复用，再利用受管资源 URL 的 `/skills/{name}` 合同做同名复用；若 GitHub Skill 只有校验后才能确定名称，则把安装器返回的“已安装同名 Skill”转成复用结果，不改 `update` 语义。

**Tech Stack:** TypeScript、Vitest、ACP ToolRuntime、SkillInstallationService

---

### Task 1: 空 Artifact ID

**Files:**
- Modify: `apps/remote/src/artifacts/artifact-tool-provider.ts`
- Test: `apps/remote/test/artifacts/artifact-tool-provider.test.ts`

- [x] **Step 1: 写失败测试**

在 `ArtifactToolProvider` 测试中准备 `artifact_id: "   "` 的 `publish_artifact`，断言准备后的参数不含 `artifact_id`，执行结果为 `publication: "created"`；同时断言 `publish_artifact_version` 的空 ID 仍被拒绝。

- [x] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @kindergarten/remote test -- artifact-tool-provider.test.ts`

Expected: `publish_artifact` 在 prepare 阶段抛出 `artifact_id 必须是非空字符串`。

- [x] **Step 3: 最小实现**

新增只用于 Artifact ID 的解析函数：

```ts
function optionalArtifactIdArg(input: Record<string, unknown>): string | undefined {
  const value = input.artifact_id;
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("artifact_id 必须是字符串");
  return value.trim() || undefined;
}
```

在发布工具的 prepare/execute 路径使用该函数；必填的新版本发布继续通过 `requiredArtifactId` 拒绝空值。

- [x] **Step 4: 运行 Artifact 测试并确认通过**

Run: `pnpm --filter @kindergarten/remote test -- artifact-tool-provider.test.ts`

Expected: 目标测试文件全部通过。

### Task 2: 同名 Skill 复用

**Files:**
- Modify: `apps/remote/src/skills/skill-installation-service.ts`
- Test: `apps/remote/test/skills/skill-installation.test.ts`

- [x] **Step 1: 写失败测试**

创建已有来源为 `http://127.0.0.1:7342/skills/website-design-fast` 的 ready Installation，再以 `http://127.0.0.1:5173/skills/website-design-fast` 执行 `ensure`。断言任务成功、结果为 `reused`、安装器没有被调用，并且 Agent 绑定已有 Installation。

再覆盖一个 GitHub 来源不同但安装器校验出同名的场景，断言“Skill 已安装”不再变成工具错误而是复用。

- [x] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @kindergarten/remote test -- skill-installation.test.ts`

Expected: 不同资源来源继续调用安装器，或被转换为 `SKILL_SOURCE_NAME_CONFLICT`。

- [x] **Step 3: 最小实现**

从受管资源 URL 的 `/skills/{name}` 提取名称提示，在 `mode === "ensure"` 时优先查找同 owner 的 ready 同名 Installation；跨 owner 命中时复用其物理 Skill 并创建 owner 独立记录。对必须经过来源校验才能知道名称的安装请求，解析安装器的 `Skill 已安装: <name>` 结果并进入同一复用辅助函数。`mode === "update"` 保持原行为。

- [x] **Step 4: 运行 Skill 测试并确认通过**

Run: `pnpm --filter @kindergarten/remote test -- skill-installation.test.ts`

Expected: 目标测试文件全部通过。

### Task 3: 回归验证

**Files:**
- Verify only: `apps/remote/src/**`
- Verify only: `apps/remote/test/**`

- [x] **Step 1: 运行 Remote 全量测试和类型检查**

Run: `pnpm --filter @kindergarten/remote test`

Expected: 全部 Remote 测试通过。

Run: `pnpm --filter @kindergarten/remote typecheck`

Expected: TypeScript 类型检查通过；若 package 未提供该脚本，则运行仓库既有 `pnpm check`。

- [x] **Step 2: 检查边界差异**

Run: `git diff -- apps/remote/src/artifacts/artifact-tool-provider.ts apps/remote/test/artifacts/artifact-tool-provider.test.ts apps/remote/src/skills/skill-installation-service.ts apps/remote/test/skills/skill-installation.test.ts`

Expected: 不包含首页提示词端口、Turn 状态、ToolRuntime 重试或工具拆分改动。
