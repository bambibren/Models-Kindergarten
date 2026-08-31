# Artifact 版本回滚与命令行下线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Artifact 支持同 ID 覆盖、服务端自增 vN 和最多三份修订回滚，同时停止向模型暴露 `run_command`。

**Architecture:** 每个用户可见版本仍是独立 Artifact ID；`publish_artifact` 可创建 v1 或覆盖指定 Artifact ID，`publish_artifact_version` 从指定 Artifact 创建新的 vN ID。每个 Artifact ID 内部保存包含当前内容在内的最近三份不可见修订，Mention 始终解析该 ID 的当前内容；`rollback_artifact` 只在用户明确要求时把历史修订恢复为新的当前修订。现有 schema v1 记录通过可选字段惰性兼容，不执行旧数据迁移。

**Tech Stack:** TypeScript、ACP、React、AtomicJsonStore、Vitest

---

### Task 1: 定义版本合同和集中保留配置

**Files:**
- Modify: `packages/contracts/src/artifacts.ts`
- Modify: `packages/contracts/src/product-config.ts`
- Modify: `packages/contracts/src/index.test.ts`

- [ ] **Step 1: 写失败测试，固定三份总修订的口径**

```ts
expect(PRODUCT_CONFIG.artifact.maxRetainedRevisions).toBe(3);
expect(PRODUCT_CONFIG.artifact.maxRetainedRevisions - 1).toBe(2);
```

- [ ] **Step 2: 运行合同测试并确认缺少配置**

Run: `pnpm --filter @kindergarten/contracts exec vitest run src/index.test.ts`

Expected: FAIL，`maxRetainedRevisions` 不存在。

- [ ] **Step 3: 增加可向后兼容的版本字段**

```ts
export interface ArtifactRevision {
  revisionId: string;
  primary: ArtifactBlobRef;
  manifest?: HtmlBundleManifest;
  sourceSessionId: string;
  sourceTurnId: string;
  operationId: string;
  createdAt: string;
}

export interface ArtifactRecord {
  // 旧记录缺少这些字段时按 seriesId=artifactId、version=1、当前内容为唯一修订解释。
  seriesId?: string;
  version?: number;
  revisions?: ArtifactRevision[];
}
```

在 `PRODUCT_CONFIG.artifact` 中集中加入：

```ts
/** 每个 Artifact ID 包含当前内容在内最多保留的修订总数。 */
maxRetainedRevisions: 3,
```

- [ ] **Step 4: 运行合同测试**

Run: `pnpm --filter @kindergarten/contracts test && pnpm --filter @kindergarten/contracts typecheck`

Expected: PASS。

### Task 2: 原子实现覆盖、vN 和回滚

**Files:**
- Modify: `apps/remote/src/artifacts/artifact-repository.ts`
- Modify: `apps/remote/src/artifacts/artifact-service.ts`
- Modify: `apps/remote/src/artifacts/artifact-blob-store.ts`
- Modify: `apps/remote/test/artifacts/artifact-service.test.ts`

- [ ] **Step 1: 写覆盖测试**

```ts
const v1 = await service.publishFile(input("session-a", "turn-1", "op-1", "page.html"));
await sandbox.writeText("page.html", "second");
const updated = await service.replaceFile(v1.artifactId, input("session-a", "turn-2", "op-2", "page.html"));
expect(updated.artifactId).toBe(v1.artifactId);
expect(updated.version).toBe(1);
expect((await service.content(v1.artifactId, "local-admin")).bytes.toString()).toBe("second");
```

- [ ] **Step 2: 写服务端自增版本测试**

```ts
const v2 = await service.publishFileVersion(v1.artifactId, input("session-a", "turn-3", "op-3", "page.html"));
const v3 = await service.publishFileVersion(v2.artifactId, input("session-a", "turn-4", "op-4", "page.html"));
expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
expect(new Set([v1.artifactId, v2.artifactId, v3.artifactId]).size).toBe(3);
expect(v2.seriesId).toBe(v1.artifactId);
```

- [ ] **Step 3: 写三份修订与回滚测试**

```ts
for (const [index, text] of ["two", "three", "four"].entries()) {
  await sandbox.writeText("page.html", text);
  await service.replaceFile(v1.artifactId, input("session-a", `turn-${index + 2}`, `op-${index + 2}`, "page.html"));
}
const current = await service.get(v1.artifactId, "local-admin");
expect(current.revisions).toHaveLength(PRODUCT_CONFIG.artifact.maxRetainedRevisions);
const rolledBack = await service.rollback(v1.artifactId, "local-admin", "session-a", "turn-r", "op-r", 2);
expect(rolledBack.artifactId).toBe(v1.artifactId);
expect(rolledBack.version).toBe(1);
```

- [ ] **Step 4: 运行测试并确认服务方法不存在**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/artifacts/artifact-service.test.ts`

Expected: FAIL，`replaceFile`、`publishFileVersion`、`rollback` 尚未实现。

- [ ] **Step 5: 实现惰性标准化和原子仓库变更**

仓库读取旧记录时使用：

```ts
function revisionsOf(record: ArtifactRecord): ArtifactRevision[] {
  return record.revisions?.length ? record.revisions : [{
    revisionId: `revision_${record.artifactId}`,
    primary: record.primary,
    ...(record.manifest ? { manifest: record.manifest } : {}),
    sourceSessionId: record.sourceSessionId,
    sourceTurnId: record.sourceTurnId,
    operationId: record.operationId,
    createdAt: record.updatedAt,
  }];
}
```

覆盖在一个 `AtomicJsonStore.update` 内完成：追加当前修订、按 `maxRetainedRevisions` 截尾、保持 `artifactId` 和用户可见 `version` 不变。创建 vN 时在同一原子更新内按 `seriesId` 求最大版本号并加一，模型不提供数字。回滚以 `steps` 选择历史修订，并把选中内容追加为新的当前修订，因此回滚本身仍可在三份窗口内撤销。

- [ ] **Step 6: 清理不再被任何当前内容或修订引用的 Blob**

给 `ArtifactBlobStore` 增加：

```ts
async prune(referencedHashes: Set<string>): Promise<void> {
  for (const name of await readdir(this.root).catch(() => [] as string[])) {
    if (/^[a-f0-9]{64}$/.test(name) && !referencedHashes.has(name)) await unlink(join(this.root, name));
  }
}
```

ArtifactService 用一个串行 mutation queue 包住发布、覆盖、创建 vN 和回滚；仓库写成功后收集全部 `primary`、`manifest.files` 和 `revisions` 引用，再调用 `prune`，避免并发上传尚未入库时被误删。

- [ ] **Step 7: 运行 Artifact Service 测试**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/artifacts/artifact-service.test.ts`

Expected: PASS。

### Task 3: 收敛成两个发布工具并增加回滚工具

**Files:**
- Modify: `apps/remote/src/artifacts/artifact-tool-provider.ts`
- Modify: `apps/remote/test/artifacts/artifact-tool-provider.test.ts`
- Modify: `apps/remote/test/artifacts/html-artifact-chain.test.ts`
- Modify: `apps/web/src/product/AgentEditorPage.tsx`

- [ ] **Step 1: 写工具面失败测试**

```ts
expect(ARTIFACT_TOOL_IDS).toEqual([
  "read_artifact",
  "publish_artifact",
  "publish_artifact_version",
  "rollback_artifact",
]);
expect(artifactToolDefinitions.map((item) => item.function.name)).not.toContain("publish_html_bundle");
```

- [ ] **Step 2: 定义统一的文件/HTML 来源参数**

两个发布工具都采用：

```ts
{
  artifact_type: "file" | "html_bundle";
  artifact_id?: string; // publish_artifact 覆盖时提供；publish_artifact_version 必填
  path?: string;        // file 必填
  root_path?: string;   // html_bundle 默认 .
  entry_path?: string;  // html_bundle 必填
  display_name?: string;
}
```

`publish_artifact` 无 `artifact_id` 时创建 v1，有 `artifact_id` 时覆盖该 ID 的当前内容；`publish_artifact_version` 必须提供 `artifact_id`，Remote 生成 vN。`rollback_artifact` 参数为：

```ts
{
  artifact_id: string;
  steps: number; // 1 到 PRODUCT_CONFIG.artifact.maxRetainedRevisions - 1
}
```

- [ ] **Step 3: 在工具结果中返回明确状态**

```ts
{
  artifactId,
  uri,
  seriesId,
  version,
  rollbackAvailable,
  publication: "created" | "replaced" | "versioned" | "rolled_back"
}
```

覆盖和回滚继续返回同一个 `artifact://`；创建 vN 返回新 ID。回滚工具描述必须写明“仅在用户明确提出回滚时调用，不得自行回滚”。

- [ ] **Step 4: 更新 HTML 链路测试**

将原 `publish_html_bundle` 调用改为：

```ts
{
  name: "publish_artifact",
  arguments: {
    artifact_type: "html_bundle",
    root_path: "site",
    entry_path: "index.html",
    display_name: "动效页面",
  },
}
```

- [ ] **Step 5: 运行工具测试**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/artifacts/artifact-tool-provider.test.ts test/artifacts/html-artifact-chain.test.ts`

Expected: PASS。

### Task 4: 把模型决策规则写进稳定提示词和工具说明

**Files:**
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/src/tools/tool-registry.ts`
- Modify: `apps/remote/test/runtime.test.ts`

- [ ] **Step 1: 写稳定提示词失败测试**

```ts
expect(systemPrompt).toContain("同一会话连续修改同一 Artifact");
expect(systemPrompt).toContain("跨会话修改、Mention 旧 Artifact");
expect(systemPrompt).toContain("版本号只能由服务端自增");
expect(systemPrompt).toContain("只有用户明确要求回滚时");
expect(systemPrompt).not.toContain("run_command");
```

- [ ] **Step 2: 更新稳定合同**

```text
- 第一次发布使用 publish_artifact，不提供 artifact_id，创建 v1。
- 同一会话连续修改同一 Artifact，且用户未要求保留旧版时，使用 publish_artifact 并提供原 artifact_id；Artifact ID 和 vN 不变。
- 跨会话修改、Mention 旧 Artifact，或用户明确要求“新版本、v2、保留旧版”时，使用 publish_artifact_version；版本号只能由服务端自增，模型不得填写。
- Mention 始终读取对应 Artifact ID 的当前内容；同版本覆盖后历史 Mention 看到新内容，这是预期行为。
- 只有用户明确要求回滚时才能调用 rollback_artifact；不得把内部修订 ID 或历史内容直接提供给用户。
```

- [ ] **Step 3: 更新 `write_file` 工具结果提醒**

把仍提到 `publish_html_bundle` 的 instruction 改为统一要求调用 `publish_artifact` 或 `publish_artifact_version`，并删除所有命令行表述。

- [ ] **Step 4: 运行 Runtime 测试**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/runtime.test.ts`

Expected: PASS。

### Task 5: 注释短路 `run_command`，停止所有模型暴露

**Files:**
- Modify: `apps/remote/src/tools/tool-registry.ts`
- Modify: `apps/remote/src/index.ts`
- Modify: `apps/remote/test/runtime.test.ts`
- Modify: `apps/remote/test/tool-loop.test.ts`
- Modify: `apps/web/src/product/AgentEditorPage.tsx`

- [ ] **Step 1: 写能力面失败测试**

```ts
const names = new ToolRegistry(sandbox).definitions.map((item) => item.function.name);
expect(names).not.toContain("run_command");
expect(agentService.capabilityOptions().builtinTools).not.toContain("run_command");
```

- [ ] **Step 2: 用集中开关短路但保留实现代码**

```ts
/** 命令行能力当前产品边界明确关闭；保留 Handler 代码但不进入模型 Tool Schema。 */
const EXPOSE_RUN_COMMAND_TOOL = false;

this.definitions = definitions.filter((definition) =>
  (EXPOSE_RUN_COMMAND_TOOL || definition.function.name !== "run_command") &&
  (this.bindings === undefined || this.bindings.get(definition.function.name)?.enabled === true));
```

`builtinToolIds()` 和 Agent 编辑页都从过滤后的 definitions 获取，因此新旧 Agent 即使保存过 `run_command` binding，Runtime 也不会向模型提供该工具。

- [ ] **Step 3: 删除提示词和模型可见说明中的命令行内容**

稳定系统提示词不得再出现 `run_command`；工具 Schema 列表不得包含它。`ProcessSandbox` 和不可达 Handler 暂时保留，满足“注释短路掉而非删除”。

- [ ] **Step 4: 把旧命令执行测试改为不可用测试**

```ts
expect(() => registry.prepare({
  id: "disabled-command",
  name: "run_command",
  arguments: { command: "printf forbidden > file.txt" },
}, "fallback")).toThrow("当前 Agent 未启用 Built-in Tool: run_command");
await expect(access(join(sandbox.root, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
```

- [ ] **Step 5: 运行 Runtime、Tool Loop 和 Agent 测试**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/runtime.test.ts test/tool-loop.test.ts test/agent`

Expected: PASS。

### Task 6: 展示 vN，但不暴露内部修订

**Files:**
- Modify: `apps/web/src/product/MePage.tsx`
- Modify: `apps/web/src/product/ArtifactDetailPage.tsx`
- Modify: `apps/web/src/product/PublishedArtifactPanel.tsx`
- Test: `apps/web/src/product/artifact-list-label.test.ts`
- Test: `apps/web/src/product/ArtifactDetailPage.test.tsx`

- [ ] **Step 1: 写展示失败测试**

```ts
expect(artifactListLabel("index.html", "session-abcdef", "动效官网", 2).title)
  .toBe("动效官网 · index.html · v2");
```

- [ ] **Step 2: 列表、详情和预览标题显示服务端版本号**

所有旧 Artifact 缺少 `version` 时显示 `v1`。UI 只展示 `vN` 和 `rollbackAvailable` 数字，不显示 `revisionId`、旧 Blob 地址或修订内容。

- [ ] **Step 3: 运行 Web 测试和类型检查**

Run: `pnpm --filter @kindergarten/web test && pnpm --filter @kindergarten/web typecheck`

Expected: PASS。

### Task 7: 全量验证，不重启服务

**Files:**
- Verify only

- [ ] **Step 1: 运行全仓类型检查与测试**

Run: `pnpm typecheck && pnpm test`

Expected: 全部 PASS。

- [ ] **Step 2: 检查工具面和提示词**

Run: `rg -n "run_command|publish_html_bundle" apps/remote/src/runtime apps/remote/src/artifacts apps/web/src/product/AgentEditorPage.tsx`

Expected: 稳定提示词、Artifact Tool Schema 和 Agent 配置入口均不再暴露这两个旧工具名；`run_command` 只存在于被集中开关短路的 Handler 代码。

- [ ] **Step 3: 不执行任何服务重启命令**

本计划不运行 `pnpm dev`、不结束当前进程、不重启 Remote 或 Web；仅依赖现有开发服务自行热更新，最终交付测试结果。
