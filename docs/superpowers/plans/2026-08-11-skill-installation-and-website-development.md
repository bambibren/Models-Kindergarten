# Skill Installation and Website Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前 Demo 中的两处手动 Skill 安装、对话安装并自动绑定、网站开发任务模板、安装进度 Banner 和静态 HTML 文件预览接成真实 Model Kindergarten 主链。

**Architecture:** 领域模型只有可变 `Agent`；Session 保存 `agentId`，每个 Prompt Turn 读取当前 Agent。手动安装走同 Remote 的 Control API；对话安装走 Runtime 原生 `ensure_agent_skills` Tool，并在整批成功后原子更新当前 Agent、刷新同 Turn 下一次模型请求的 Skill 能力。聊天仍只消费官方 ACP Update，安装 Banner 是 Tool 状态的临时投影。

**Tech Stack:** TypeScript 7、React 19、Vite 8、Vitest 4、ACP SDK 1.3、Node.js 22、现有 FileSandbox/ToolRuntime/Ollama Provider。

---

## 文件结构

### Shared Contracts

- Create: `packages/contracts/src/skill-management.ts` — Skill、Agent、安装批次、namespaced ACP 进度合同。
- Modify: `packages/contracts/src/index.ts` — 导出合同与严格解析函数。
- Test: `packages/contracts/src/skill-management.test.ts` — 解析、状态和 `_meta` 校验。

### Remote Control Plane

- Create: `apps/remote/src/agent/agent-types.ts` — 单一可变 Agent 结构。
- Create: `apps/remote/src/agent/agent-store.ts` — 原子 JSON Store 与 ETag。
- Create: `apps/remote/src/agent/agent-service.ts` — 页面全量更新和对话 Skill 并集更新。
- Create: `apps/remote/src/skills/github-skill-source.ts` — GitHub tree URL 规范化。
- Create: `apps/remote/src/skills/skill-install-job-store.ts` — 安装批次与逐项状态。
- Create: `apps/remote/src/skills/skill-install-service.ts` — 两手动入口与 Tool 共用的安装服务。
- Create: `apps/remote/src/server/control-api.ts` — Skills、Agents、文件读取接口路由。
- Modify: `apps/remote/src/server/http-server.ts` — `/health` 之外挂载同源 Control API。
- Test: `apps/remote/test/agent-store.test.ts`
- Test: `apps/remote/test/skill-install-service.test.ts`
- Test: `apps/remote/test/control-api.test.ts`

### Runtime Data Plane

- Create: `apps/remote/src/skills/ensure-agent-skills-provider.ts` — Runtime 原生 Tool Provider。
- Create: `apps/remote/src/capability/runtime-capability-resolver.ts` — 按当前 Agent 动态构造 Catalog。
- Modify: `apps/remote/src/skills/skill-registry.ts` — 安装成功后的确定刷新。
- Modify: `apps/remote/src/skills/skill-tool-provider.ts` — 去掉构造期冻结的 `allowedIds`。
- Modify: `apps/remote/src/runtime/agent-runtime.ts` — Tool 完成后的显式 capability refresh。
- Modify: `apps/remote/src/acp/acp-output.ts` — 保留 Skill 安装 `_meta` 与文件 `resource_link`。
- Modify: `apps/remote/src/acp/kindergarten-agent.ts` — Session 解析 `agentId` 与进度转发。
- Test: `apps/remote/test/ensure-agent-skills.test.ts`
- Test: `apps/remote/test/runtime-capability-refresh.test.ts`

### Web Production UI

- Create: `apps/web/src/management/skill-client.ts` — Control API 客户端。
- Create: `apps/web/src/management/agent-client.ts` — Agent CRUD 客户端。
- Create: `apps/web/src/components/skills/SkillInstallControl.tsx` — 两手动入口共用控件。
- Create: `apps/web/src/components/skills/SkillInstallActivityBanner.tsx` — Composer 上方临时状态。
- Create: `apps/web/src/chat/skill-install-operation.ts` — 从 ACP Tool `_meta` 归约操作状态。
- Modify: `apps/web/src/chat/chat-types.ts` — `activeOperations`。
- Modify: `apps/web/src/chat/chat-reducer.ts` — Tool entry 与临时操作并行归约。
- Modify: `apps/web/src/App.tsx` — Composer stack 与 Banner。
- Modify: `apps/web/src/components/chat/ContentRenderer.tsx` — `resource_link` 触发内部文件打开。
- Create: `apps/web/src/components/files/FilePreviewPanel.tsx` — 按需静态预览。
- Test: `apps/web/src/chat/skill-install-operation.test.ts`
- Test: `apps/web/src/chat/chat-reducer.test.ts`

### Product Shell Integration

- 以 `apps/web/src/demo/model-home/ModelHomePage.tsx`、`demo/me/MePage.tsx`、`demo/agent-editor/AgentEditorPage.tsx`、`demo/session/SessionDemoPage.tsx` 为交互基线。
- 先把真实数据端口作为 props/clients 注入，再将 `/demo/*` 壳迁移到真实路由；不要在 Demo 组件内部直接创建第二个 ACP owner。

---

### Task 1: 冻结单 Agent 与 Skill 安装合同

**Files:**
- Create: `packages/contracts/src/skill-management.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/skill-management.test.ts`

- [ ] **Step 1: 写失败的合同解析测试**

```ts
import { describe, expect, it } from "vitest";
import { readSkillInstallMeta } from "./skill-management.js";

describe("skill install contracts", () => {
  it("accepts a namespaced install progress payload", () => {
    expect(readSkillInstallMeta({
      "kindergarten/skill-install": {
        batchId: "batch-1",
        phase: "validating",
        completed: 1,
        total: 3,
        items: [{ sourceUrl: "https://github.com/a/b/tree/main/skills/x", status: "ready" }],
      },
    })?.batchId).toBe("batch-1");
  });

  it("rejects unknown phases and missing item URLs", () => {
    expect(readSkillInstallMeta({ "kindergarten/skill-install": { phase: "done" } })).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @kindergarten/contracts test -- skill-management.test.ts`

Expected: FAIL，提示 `skill-management.js` 或 `readSkillInstallMeta` 不存在。

- [ ] **Step 3: 实现最小合同**

```ts
export const skillInstallPhases = ["queued", "fetching", "validating", "publishing", "ready", "failed", "cancelled"] as const;
export type SkillInstallPhase = typeof skillInstallPhases[number];

export interface AgentRecord {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  systemPrompt: string;
  enabledToolIds: string[];
  skillInstallationIds: string[];
  mcpBindings: string[];
  historyTurns: number;
  etag: string;
  updatedAt: number;
}

export interface SkillInstallProgressMeta {
  batchId: string;
  phase: SkillInstallPhase;
  completed: number;
  total: number;
  items: Array<{ sourceUrl: string; skillId?: string; status: SkillInstallPhase | "reused" }>;
}

export function readSkillInstallMeta(value: unknown): SkillInstallProgressMeta | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)["kindergarten/skill-install"];
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<SkillInstallProgressMeta>;
  if (typeof item.batchId !== "string" || !skillInstallPhases.includes(item.phase as SkillInstallPhase)) return null;
  if (!Number.isInteger(item.completed) || !Number.isInteger(item.total) || !Array.isArray(item.items)) return null;
  if (!item.items.every((entry) => entry && typeof entry === "object" && typeof (entry as { sourceUrl?: unknown }).sourceUrl === "string")) return null;
  return item as SkillInstallProgressMeta;
}
```

Export these names from `packages/contracts/src/index.ts`.

- [ ] **Step 4: 运行合同测试与类型检查**

Run: `pnpm --filter @kindergarten/contracts test && pnpm --filter @kindergarten/contracts typecheck`

Expected: PASS；合同包无 TypeScript 错误。

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/skill-management.ts packages/contracts/src/skill-management.test.ts packages/contracts/src/index.ts
git commit -m "feat: define mutable agent and skill install contracts"
```

### Task 2: 实现单一可变 Agent Store

**Files:**
- Create: `apps/remote/src/agent/agent-types.ts`
- Create: `apps/remote/src/agent/agent-store.ts`
- Create: `apps/remote/src/agent/agent-service.ts`
- Test: `apps/remote/test/agent-store.test.ts`

- [ ] **Step 1: 写 Agent 同 ID 更新和 Skill 并集测试**

```ts
it("updates the same Agent and unions conversation-installed skills", async () => {
  const store = new AgentStore(tempRoot);
  const created = await store.create(agentFixture());
  const edited = await store.replace(created.id, created.etag, { ...created, name: "网页 Agent" });
  const bound = await new AgentService(store).addReadySkills(edited.id, ["install-a", "install-b"]);
  expect(bound.id).toBe(created.id);
  expect(bound.name).toBe("网页 Agent");
  expect(bound.skillInstallationIds).toEqual(["install-a", "install-b"]);
  expect(bound.etag).not.toBe(created.etag);
  expect("revision" in bound).toBe(false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @kindergarten/remote test -- agent-store.test.ts`

Expected: FAIL，AgentStore 尚不存在。

- [ ] **Step 3: 实现原子 Store 与 ETag**

```ts
export class AgentStore {
  constructor(private readonly root: string) {}

  async create(input: Omit<AgentRecord, "etag" | "updatedAt">): Promise<AgentRecord> {
    const agent = stamp(input);
    const agents = await this.all();
    if (agents.some((item) => item.id === agent.id)) throw new Error(`Agent 已存在: ${agent.id}`);
    await this.write([...agents, agent]);
    return agent;
  }

  async replace(id: string, expectedEtag: string, input: AgentRecord): Promise<AgentRecord> {
    const agents = await this.all();
    const current = agents.find((item) => item.id === id);
    if (!current) throw new Error(`Agent 不存在: ${id}`);
    if (current.etag !== expectedEtag) throw new AgentEtagConflict(id);
    const next = stamp({ ...input, id, ownerId: current.ownerId });
    await this.write(agents.map((item) => item.id === id ? next : item));
    return next;
  }
}

export class AgentService {
  constructor(private readonly store: AgentStore) {}

  async addReadySkills(agentId: string, installationIds: string[]): Promise<AgentRecord> {
    const current = await this.store.get(agentId);
    const skillInstallationIds = [...new Set([...current.skillInstallationIds, ...installationIds])];
    return this.store.replace(agentId, current.etag, { ...current, skillInstallationIds });
  }
}
```

`write()` 必须使用同目录临时文件、`fsync` 和 `rename`，不能直接覆盖事实文件。

- [ ] **Step 4: 测试 CAS 冲突与原子写入**

Run: `pnpm --filter @kindergarten/remote test -- agent-store.test.ts`

Expected: PASS；旧 ETag 更新得到 `AgentEtagConflict`，Skill 并集不覆盖其他字段。

- [ ] **Step 5: Commit**

```bash
git add apps/remote/src/agent apps/remote/test/agent-store.test.ts
git commit -m "feat: add mutable agent store"
```

### Task 3: 把现有 SkillInstaller 提升为可观察安装服务

**Files:**
- Create: `apps/remote/src/skills/github-skill-source.ts`
- Create: `apps/remote/src/skills/skill-install-job-store.ts`
- Create: `apps/remote/src/skills/skill-install-service.ts`
- Modify: `apps/remote/src/skills/skill-installer.ts`
- Modify: `apps/remote/src/skills/skill-registry.ts`
- Test: `apps/remote/test/skill-install-service.test.ts`

- [ ] **Step 1: 写 URL 解析、幂等与阶段测试**

```ts
it("normalizes a GitHub tree URL and reuses an identical Ready install", async () => {
  const source = parseGitHubSkillUrl("https://github.com/anthropics/skills/tree/main/skills/frontend-design");
  expect(source).toEqual({
    repositoryUrl: "https://github.com/anthropics/skills.git",
    ref: "main",
    subdir: "skills/frontend-design",
    sourceUrl: "https://github.com/anthropics/skills/tree/main/skills/frontend-design",
  });
  const first = await service.ensure(source.sourceUrl, observer);
  const second = await service.ensure(source.sourceUrl, observer);
  expect(first.result).toBe("installed");
  expect(second.result).toBe("reused");
  expect(observer.phases).toEqual(["queued", "fetching", "validating", "publishing", "ready"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @kindergarten/remote test -- skill-install-service.test.ts`

Expected: FAIL，解析器与服务不存在。

- [ ] **Step 3: 实现严格 GitHub URL 解析**

```ts
export function parseGitHubSkillUrl(input: string): GitHubSkillSource {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) {
    throw new SkillInstallError("INVALID_SOURCE", "只支持无凭证的 GitHub HTTPS 目录 URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 6 || parts[2] !== "tree") {
    throw new SkillInstallError("INVALID_SOURCE", "地址必须包含 /tree/{ref}/{skill-directory}");
  }
  const [owner, repo, , ref, ...subdir] = parts;
  if (!owner || !repo || !ref || subdir.length === 0) throw new SkillInstallError("INVALID_SOURCE", "Skill 目录不完整");
  return {
    sourceUrl: url.toString(),
    repositoryUrl: `https://github.com/${owner}/${repo}.git`,
    ref,
    subdir: subdir.join("/"),
  };
}
```

- [ ] **Step 4: 实现阶段 observer 和 Registry refresh**

```ts
export interface SkillInstallObserver {
  phase(value: SkillInstallPhase): Promise<void>;
}

export class SkillInstallService {
  async ensure(sourceUrl: string, observer: SkillInstallObserver): Promise<EnsureSkillResult> {
    const source = parseGitHubSkillUrl(sourceUrl);
    const existing = this.lock.findBySource(source.sourceUrl);
    if (existing) return { result: "reused", record: existing };
    await observer.phase("queued");
    await observer.phase("fetching");
    const record = await this.installer.install({ source: { kind: "git", url: source.repositoryUrl, ref: source.ref, subdir: source.subdir }, approved: true });
    await observer.phase("validating");
    await observer.phase("publishing");
    await this.registry.refresh();
    await observer.phase("ready");
    return { result: "installed", record };
  }
}
```

实际 `SkillInstaller` 需要把阶段 hook 放在真实 fetch/validate/publish 边界；不要像示例一样在完成后补发假阶段。

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @kindergarten/remote test -- skill-install-service.test.ts`

Expected: PASS；同 URL Ready 为 reused，同名不同来源为 `SKILL_NAME_CONFLICT`。

- [ ] **Step 6: Commit**

```bash
git add apps/remote/src/skills apps/remote/test/skill-install-service.test.ts
git commit -m "feat: add observable skill install service"
```

### Task 4: 增加同源 Control API

**Files:**
- Create: `apps/remote/src/server/control-api.ts`
- Modify: `apps/remote/src/server/http-server.ts`
- Test: `apps/remote/test/control-api.test.ts`

- [ ] **Step 1: 写 API 合同测试**

```ts
it("installs a skill without changing any Agent", async () => {
  const before = await agentStore.get("agent-default");
  const response = await request.post("/api/control/v1/skills/install").send({
    source: { kind: "github_folder_url", url: FRONTEND_DESIGN_URL },
    trust: "restricted",
    entry: "skills_tab",
  });
  expect(response.status).toBe(202);
  expect((await agentStore.get("agent-default")).etag).toBe(before.etag);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @kindergarten/remote test -- control-api.test.ts`

Expected: FAIL，当前只有 `/health`。

- [ ] **Step 3: 实现明确路由**

```ts
export async function handleControlRequest(request: IncomingMessage, response: ServerResponse, deps: ControlDeps): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://remote.local");
  if (request.method === "GET" && url.pathname === "/api/control/v1/skills") {
    return json(response, 200, await deps.skills.list());
  }
  if (request.method === "POST" && url.pathname === "/api/control/v1/skills/install") {
    const body = readInstallRequest(await readJson(request));
    return json(response, 202, await deps.skills.startManual(body));
  }
  if (request.method === "GET" && url.pathname === "/api/control/v1/agents") {
    return json(response, 200, await deps.agents.list());
  }
  return false;
}
```

`http-server.ts` 先处理 `/health` 和 Control API，再处理 WebSocket upgrade；未知 HTTP 路径仍返回 404。

- [ ] **Step 4: 运行 API 测试**

Run: `pnpm --filter @kindergarten/remote test -- control-api.test.ts`

Expected: PASS；非法 URL 返回稳定错误码，手动安装不修改 Agent。

- [ ] **Step 5: Commit**

```bash
git add apps/remote/src/server apps/remote/test/control-api.test.ts
git commit -m "feat: expose skill and agent control api"
```

### Task 5: 实现 `ensure_agent_skills` Runtime Tool

**Files:**
- Create: `apps/remote/src/skills/ensure-agent-skills-provider.ts`
- Modify: `apps/remote/src/index.ts`
- Test: `apps/remote/test/ensure-agent-skills.test.ts`

- [ ] **Step 1: 写 Tool schema、目标 Agent 注入和批次原子性测试**

```ts
it("binds all Ready items to the current Session Agent and accepts no agentId argument", async () => {
  const provider = fixtureProvider({ sessionId: "s1", agentId: "agent-current" });
  expect(provider.definitions[0]?.function.parameters.properties).not.toHaveProperty("agentId");
  const result = await provider.execute(preparedEnsureCall([URL_A, URL_B]), executionContext);
  expect(result.rawOutput).toMatchObject({ status: "ready", agentId: "agent-current", capabilityRefreshed: true });
  expect((await agentStore.get("agent-current")).skillInstallationIds).toHaveLength(2);
});

it("keeps the Agent unchanged when one item fails", async () => {
  installer.fail(URL_B, "INVALID_SKILL_PACKAGE");
  await provider.execute(preparedEnsureCall([URL_A, URL_B]), executionContext);
  expect((await agentStore.get("agent-current")).skillInstallationIds).toEqual([]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @kindergarten/remote test -- ensure-agent-skills.test.ts`

Expected: FAIL，Provider 未注册。

- [ ] **Step 3: 定义批量幂等 Tool**

```ts
const definition: ModelToolDefinition = {
  type: "function",
  function: {
    name: "ensure_agent_skills",
    description: "安装用户当前消息明确提供的 Skills，并在整批成功后启用到当前 Agent。已安装项复用，V1 不升级。",
    parameters: {
      type: "object",
      properties: {
        source_urls: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
        upgrade: { const: false },
      },
      required: ["source_urls"],
      additionalProperties: false,
    },
  },
};
```

Provider 从 `ToolExecutionContext` 读取 `sessionId/agentId/userPromptText`，验证每个 URL 出现在当前用户消息且有安装意图；否则将 permission 设为 `ask`。

- [ ] **Step 4: 安装完成后一次性绑定**

```ts
const results = await Promise.all(urls.map((url) => this.install.ensure(url, itemObserver(url))));
if (results.some((item) => item.result === "failed")) return failedOutcome(results);
const installationIds = results.map((item) => item.record.id);
const agent = await this.agents.addReadySkills(context.agentId, installationIds);
context.invalidateCapabilities();
return readyOutcome(agent.id, results);
```

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @kindergarten/remote test -- ensure-agent-skills.test.ts`

Expected: PASS；全部成功才改 Agent，重复请求返回 reused，Tool 输入无 agentId。

- [ ] **Step 6: Commit**

```bash
git add apps/remote/src/skills/ensure-agent-skills-provider.ts apps/remote/src/index.ts apps/remote/test/ensure-agent-skills.test.ts
git commit -m "feat: add conversational skill installation tool"
```

### Task 6: 在同一 Prompt Turn 中刷新能力

**Files:**
- Create: `apps/remote/src/capability/runtime-capability-resolver.ts`
- Modify: `apps/remote/src/capability/runtime-capability-catalog.ts`
- Modify: `apps/remote/src/skills/skill-tool-provider.ts`
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Test: `apps/remote/test/runtime-capability-refresh.test.ts`

- [ ] **Step 1: 写“第二次模型请求看到新 Skill”测试**

```ts
it("rebuilds the catalog after ensure_agent_skills before the next model request", async () => {
  const provider = scriptedModel([
    toolCall("ensure_agent_skills", { source_urls: [URL_A] }),
    toolCall("activate_skill", { skill_id: "frontend-design" }),
    text("完成"),
  ]);
  await runtime.run(runInput("安装并使用"), observer, signal);
  expect(provider.requests[0]?.tools.map(toolName)).toContain("ensure_agent_skills");
  expect(provider.requests[1]?.context).toContain("frontend-design");
  expect(provider.requests[1]?.tools.map(toolName)).toContain("activate_skill");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @kindergarten/remote test -- runtime-capability-refresh.test.ts`

Expected: FAIL；当前 `toolDefinitions` 和 allowedIds 在 Turn 开始冻结。

- [ ] **Step 3: 把 Catalog 构造变为可解析函数**

```ts
export interface RuntimeCapabilityResolver {
  resolve(sessionId: string, agentId: string): Promise<{
    generation: number;
    registry: ToolRegistryPort;
    definitions: ModelToolDefinition[];
    contextSegments: ContextSegment[];
  }>;
}
```

`SkillToolProvider` 在 `prepare/execute` 时读取 resolver 当前允许集合，错误文案改为“当前 Agent 未绑定 Skill”，删除 `AgentVersion`。

- [ ] **Step 4: 在模型循环轮次边界检查 invalidation**

```ts
let capabilities = await this.capabilities.resolve(input.sessionId, input.agentId);
for (let round = 0; ; round += 1) {
  const response = this.model.stream({ messages, tools: capabilities.definitions }, signal);
  // ...执行 Tool batch...
  if (batch.some((item) => item.result.capabilityChanged === true)) {
    capabilities = await this.capabilities.resolve(input.sessionId, input.agentId);
    messages.push(...capabilities.contextSegments.map(toModelMessage));
  }
}
```

不要重新组装或重复添加历史与当前用户 Prompt；只替换 Agent/Skill catalog 相关段，并为新的 Model Step 生成真实 `TurnContextRecord`。

- [ ] **Step 5: 运行 Runtime 回归测试**

Run: `pnpm --filter @kindergarten/remote test -- runtime-capability-refresh.test.ts runtime.test.ts tool-loop.test.ts`

Expected: PASS；普通 Tool 不刷新，安装 Tool 只刷新一次，新 Skill 可在下一 Model Step 激活。

- [ ] **Step 6: Commit**

```bash
git add apps/remote/src/capability apps/remote/src/skills/skill-tool-provider.ts apps/remote/src/runtime/agent-runtime.ts apps/remote/test/runtime-capability-refresh.test.ts
git commit -m "feat: refresh skills after explicit capability change"
```

### Task 7: 归约安装操作并显示 Composer Banner

**Files:**
- Create: `apps/web/src/chat/skill-install-operation.ts`
- Create: `apps/web/src/chat/skill-install-operation.test.ts`
- Create: `apps/web/src/components/skills/SkillInstallActivityBanner.tsx`
- Modify: `apps/web/src/chat/chat-types.ts`
- Modify: `apps/web/src/chat/chat-reducer.ts`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: 写临时操作与 Tool 历史并存测试**

```ts
it("projects install progress without changing first-seen chat order", () => {
  const started = reduceUpdate(emptyPromptState(), toolStart("install-1", "ensure_agent_skills"));
  const progressed = reduceUpdate(started, installUpdate("install-1", { phase: "validating", completed: 1, total: 3 }));
  expect(progressed.streamingChatEntries.order).toEqual(["tool:install-1"]);
  expect(progressed.activeOperations["batch-1"]?.phase).toBe("validating");
  const done = reduceUpdate(progressed, installCompleted("install-1"));
  expect(done.streamingChatEntries.byId["tool:install-1"]).toBeDefined();
  expect(done.activeOperations["batch-1"]).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @kindergarten/web test -- skill-install-operation.test.ts`

Expected: FAIL，ChatState 没有 activeOperations。

- [ ] **Step 3: 增加操作投影**

```ts
export interface SkillInstallOperation {
  type: "skill_install";
  batchId: string;
  toolCallId: string;
  phase: SkillInstallPhase;
  completed: number;
  total: number;
  items: SkillInstallProgressMeta["items"];
}

export interface ChatState {
  // existing fields
  activeOperations: Record<string, SkillInstallOperation>;
}
```

`reduceTool` 先维持现有 `streamingChatEntries` 原位 upsert，再解析 `_meta` 更新 `activeOperations`。Tool 到 `completed/failed/cancelled` 后删除对应 operation；不要删除 Tool entry。

- [ ] **Step 4: 实现 Banner**

```tsx
export function SkillInstallActivityBanner({ operation }: { operation: SkillInstallOperation }) {
  return <details className="skill-install-banner">
    <summary>
      <Loader size={14} />
      <span>正在为当前 Agent 准备网站设计 Skills</span>
      <small>{operation.completed}/{operation.total}</small>
    </summary>
    <ul>{operation.items.map((item) => <li key={item.sourceUrl}>
      <span>{item.skillId ?? skillNameFromUrl(item.sourceUrl)}</span><small>{phaseLabel(item.status)}</small>
    </li>)}</ul>
  </details>;
}
```

Banner 放在 `InteractionPendingPanel` 与 Composer 的同一 stack 中；使用当前暖灰主题。全部终态后只做 500–800ms “已就绪”过渡，再卸载。

- [ ] **Step 5: 运行 Web 测试和类型检查**

Run: `pnpm --filter @kindergarten/web test && pnpm --filter @kindergarten/web typecheck`

Expected: PASS；并行 Tool 顺序测试不变。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/chat apps/web/src/components/skills apps/web/src/App.tsx
git commit -m "feat: show active skill installation above composer"
```

### Task 8: 接入两处手动安装和单 Agent 编辑

**Files:**
- Create: `apps/web/src/management/skill-client.ts`
- Create: `apps/web/src/management/agent-client.ts`
- Create: `apps/web/src/components/skills/SkillInstallControl.tsx`
- Modify or promote from Demo: Model Home、Me/Skills、Agent Editor production pages
- Test: `apps/web/src/management/skill-client.test.ts`

- [ ] **Step 1: 写“手动安装不自动选中”的纯状态测试**

```ts
it("refreshes Ready skills without changing the Agent selection", () => {
  const before = { selectedInstallationIds: ["existing"] };
  const after = applyManualInstallReady(before, { id: "new", status: "ready" });
  expect(after.selectedInstallationIds).toEqual(["existing"]);
  expect(after.availableInstallationIds).toContain("new");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @kindergarten/web test -- skill-client.test.ts`

Expected: FAIL，真实管理端口不存在。

- [ ] **Step 3: 实现共用安装控件**

```tsx
<SkillInstallControl
  entry="skills_tab"
  onReady={(skill) => setSkills((current) => upsertSkill(current, skill))}
/>
```

Agent 编辑页传 `entry="agent_editor"`，`onReady` 只刷新可选列表，不调用 checkbox updater。只有 `status === "ready"` 的项启用 checkbox。

- [ ] **Step 4: 接入单 Agent 保存**

Agent 表单只显示“保存 Agent”；客户端调用 `PUT /agents/:id` 并带 `If-Match`。删除所有 AgentVersion/Revision 文案、ID 和页面入口。Context Lab 的 A/B/C 改称“对照方案”，但保持其实验行为。

- [ ] **Step 5: 接入网站开发模板与真实 Agent 选择**

复用 Demo 中最终确认的提示词常量。点击网站开发直接 `setPrompt(websiteDevelopmentPrompt)`；提交时保存真实 `selectedAgentId`，Session 创建请求只发送 `modelStudentId + agentId`。

- [ ] **Step 6: 运行页面测试、构建并浏览器验证**

Run: `pnpm --filter @kindergarten/web test && pnpm --filter @kindergarten/web build`

Expected: PASS；SkillsTab、Agent Editor、Model Home 三条路径无控制台错误。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/management apps/web/src/components/skills apps/web/src/pages apps/web/src/main.tsx
git commit -m "feat: connect skill management and mutable agents"
```

### Task 9: 将写文件结果投影为按需静态预览

**Files:**
- Modify: `apps/remote/src/tools/tool-registry.ts`
- Modify: `apps/remote/src/acp/acp-output.ts`
- Create: `apps/remote/src/server/file-reference-resolver.ts`
- Create: `apps/web/src/components/files/FilePreviewPanel.tsx`
- Modify: `apps/web/src/components/chat/ContentRenderer.tsx`
- Test: `apps/remote/test/file-reference.test.ts`
- Test: `apps/web/src/components/files/file-preview-state.test.ts`

- [ ] **Step 1: 写 resource_link 与所有权测试**

```ts
it("returns a stable resource_link and rejects free-form paths", async () => {
  const outcome = await writeFile("site/index.html", "<main>ok</main>");
  expect(outcome.content).toContainEqual(expect.objectContaining({
    type: "content",
    content: expect.objectContaining({ type: "resource_link", name: "index.html", mimeType: "text/html" }),
  }));
  await expect(resolver.read({ userId: "other", fileReferenceId: outcome.fileReferenceId })).rejects.toThrow("无权读取");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @kindergarten/remote test -- file-reference.test.ts`

Expected: FAIL，当前 write_file 只返回文本/diff。

- [ ] **Step 3: 生成标准 Resource Link**

```ts
const link = {
  type: "content" as const,
  content: {
    type: "resource_link" as const,
    uri: `mk-file://sessions/${sessionId}/files/${reference.id}`,
    name: basename(reference.sandboxPath),
    mimeType: reference.mimeType,
    size: reference.size,
  },
};
```

- [ ] **Step 4: 实现点击后挂载的安全预览**

`ContentRenderer` 拦截 `mk-file://` 并调用内部 `onOpenFileReference`，不打开新标签。`FilePreviewPanel` 读取已认证内容、净化 HTML、注入 CSP，再使用 `<iframe sandbox="" srcDoc={html} />`。没有 active file 时不渲染中栏。

- [ ] **Step 5: 测试与构建**

Run: `pnpm --filter @kindergarten/remote test -- file-reference.test.ts && pnpm --filter @kindergarten/web test -- file-preview-state.test.ts && pnpm build`

Expected: PASS；外部资源、脚本、事件属性被阻断。

- [ ] **Step 6: Commit**

```bash
git add apps/remote/src/tools apps/remote/src/acp apps/remote/src/server apps/web/src/components/files apps/web/src/components/chat/ContentRenderer.tsx
git commit -m "feat: open generated files in a sandboxed preview"
```

### Task 10: 完成真实 8B 端到端验收

**Files:**
- Create: `apps/remote/test/website-development.e2e.test.ts`
- Create: `docs/verification/2026-08-11-website-development.md`

- [ ] **Step 1: 增加可重复的 E2E 场景**

测试必须覆盖：已有 Composer 文本被模板覆盖、三地址用户可见、安装 Tool 进度、整批 Agent 绑定、同 Turn activate、write permission、`site/index.html`、resource_link、按需预览、重复请求 reused、单项失败不绑定。

- [ ] **Step 2: 运行完整自动化检查**

Run: `pnpm typecheck && pnpm test && pnpm build`

Expected: 所有 workspace PASS；无新增 snapshot 更新或跳过测试。

- [ ] **Step 3: 启动真实服务**

Run: `pnpm dev:remote` 和 `pnpm dev:web`

Expected: Remote `/health` 200；Web 可连接 ACP；Ollama `qwen3:8b` 可用。

- [ ] **Step 4: 浏览器逐步验证**

按 TRD 附录 B/C 脚本执行，截图并在 `docs/verification/2026-08-11-website-development.md` 记录：每一步 URL、页面状态、ToolCallId、batchId、Agent ID/ETag、生成文件与控制台结果。不能只写“通过”。

- [ ] **Step 5: 验证产品边界**

确认没有 AgentVersion/AgentRevision 页面或字段；没有预装设计 Skill；没有文件树、DOM 编辑器、设备壳、全屏或 Runtime 面板；Demo `/demo/*` 仍不拥有 ACP connection。

- [ ] **Step 6: Commit**

```bash
git add apps/remote/test/website-development.e2e.test.ts docs/verification/2026-08-11-website-development.md
git commit -m "test: verify website development skill flow"
```

---

## 自审结果

- 规格覆盖：三种安装入口、输入覆盖、用户可见来源、单 Agent、同 Turn 刷新、Banner、稳定 Tool 顺序、HTML 预览均有独立任务。
- 占位扫描：所有未来能力均有明确文件、合同、测试命令和成功条件，没有未指定的实现步骤。
- 类型一致性：统一使用 `AgentRecord`、`SkillInstallProgressMeta`、`SkillInstallBatch`、`capabilityGeneration`、`activeOperations`；没有 Revision/Version 字段。
- 实施边界：本计划用于后续真实功能执行；当前轮只更新文档和 `/apps/web/src/demo/**`。
