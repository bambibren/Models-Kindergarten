# Phase 1 Local Cloud-Ready Refactor Implementation Plan

> Secret 持久化的后续决定已由 [Encrypted Secret Vault Implementation Plan](2026-08-29-encrypted-secret-vault.md) 取代：本机源码、Docker 预演和云端现在统一使用加密文件 Vault，不再保留 Keychain 正式后端。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 MK 本地源码运行重构成不依赖内置 Ollama、只有一个 Web、浏览器只使用同源路径且可直接生成云端运行产物的最终开发形态。

**Architecture:** Remote 以空 ModelStudentCatalog 启动，所有 Provider（包括本机 Ollama）通过统一入园恢复并按 Session 解析；Web 合并 Evaluation 页面并由 Vite 将 `/api`、`/acp` 代理到 Remote，Remote 再把 Evaluation 读取请求转给独立 Evaluation Service。macOS Keychain 保留为本地 SecretStore 后端，但持久化记录改用后端无关的 managed 引用。

**Tech Stack:** TypeScript 7、Node.js 22 ESM、React 19、Vite 8、Vitest 4、pnpm 11、ACP SDK。

---

## 文件结构

```text
packages/contracts/src/model-admission.ts
└─ Ollama 入园协议、无凭据预设、能力快照合同

apps/remote/src/config/deployment-config.ts
└─ local-source / docker-preview / cloud 配置与监听策略

apps/remote/src/model/ollama-admission-adapter.ts
└─ 本机回环 URL 校验、Ollama 体检与 Provider 创建

apps/remote/src/model/model-student-catalog.ts
└─ 空目录启动、受管 Provider 注册、停用元数据

apps/remote/src/model/model-admission-*.ts
└─ 可选凭据、managed Secret、archived 生命周期、旧内置模型迁移

apps/remote/src/server/evaluation-proxy.ts
└─ `/api/evaluation/v1/*` 到 Evaluation Service 的受控转发

apps/remote/src/server/http-server.ts
└─ live / ready、Evaluation Proxy、零模型诊断

apps/web/src/evaluation/*
└─ 原 Evaluation Web 页面、状态、样式和测试

apps/web/src/main.tsx
└─ `/evaluation/*` 延迟加载

apps/web/vite.config.ts
└─ `/api` 与 `/acp` 本地同源代理
```

### Task 1: 固化基线并增加部署配置

**Files:**
- Create: `apps/remote/src/config/deployment-config.ts`
- Test: `apps/remote/test/config/deployment-config.test.ts`
- Modify: `apps/remote/src/index.ts`

- [x] **Step 1: 写配置失败测试**

```ts
expect(readDeploymentConfig({}).host).toBe("127.0.0.1");
expect(() => readDeploymentConfig({ HOST: "0.0.0.0" })).toThrow("local-source");
expect(readDeploymentConfig({ DEPLOYMENT_PROFILE: "docker-preview", HOST: "0.0.0.0" }).host)
  .toBe("0.0.0.0");
```

- [x] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @kindergarten/remote test -- test/config/deployment-config.test.ts`

Expected: FAIL，模块尚不存在。

- [x] **Step 3: 实现配置读取器**

```ts
export type DeploymentProfile = "local-source" | "docker-preview" | "cloud";
export interface DeploymentConfig {
  profile: DeploymentProfile;
  host: string;
  port: number;
  dataDir: string;
  evaluationUrl: string;
}
```

local-source 仅允许回环地址；docker-preview/cloud 允许容器监听 `0.0.0.0`。

- [x] **Step 4: 运行测试并确认通过**

Run: `pnpm --filter @kindergarten/remote test -- test/config/deployment-config.test.ts`

Expected: PASS。

### Task 2: 把 Secret 引用改成后端无关

**Files:**
- Modify: `apps/remote/src/mcp/mcp-types.ts`
- Modify: `apps/remote/src/mcp/secret-store.ts`
- Modify: `apps/remote/src/model/model-admission-repository.ts`
- Modify: `apps/remote/src/model/model-admission-service.ts`
- Test: `apps/remote/test/mcp/secret-store.test.ts`
- Test: `apps/remote/test/model/model-admission-repository.test.ts`

- [x] **Step 1: 写 managed Secret 测试**

```ts
const ref = { provider: "managed", key: "models/provider-connections/a" } as const;
await store.write(ref, "secret");
await expect(store.read(ref)).resolves.toBe("secret");
```

- [x] **Step 2: 新增逻辑引用并兼容旧 keychain 记录**

```ts
export type SecretRef =
  | { provider: "env"; key: string }
  | { provider: "managed"; key: string }
  | { provider: "keychain"; key: string }; // 只读旧数据迁移兼容
```

`HostSecretStore` 将 managed 和旧 keychain 都映射到 macOS Keychain；新模型只写 managed。

- [x] **Step 3: 持久化迁移**

`persistMigrations()` 把模型连接中的 `provider: "keychain"` 原子改写为 `provider: "managed"`。

- [x] **Step 4: 运行 Secret 与 Repository 测试**

Run: `pnpm --filter @kindergarten/remote test -- test/mcp/secret-store.test.ts test/model/model-admission-repository.test.ts`

Expected: PASS，公开 Connection 仍不泄露 Secret 引用。

### Task 3: 增加 Ollama 普通入园协议

**Files:**
- Modify: `packages/contracts/src/model-admission.ts`
- Modify: `apps/remote/src/model/model-provider-preset-registry.ts`
- Modify: `apps/remote/src/model/model-admission-adapter-registry.ts`
- Create: `apps/remote/src/model/ollama-admission-adapter.ts`
- Modify: `apps/remote/src/model/model-admission-repository.ts`
- Modify: `apps/remote/src/model/model-admission-service.ts`
- Modify: `apps/web/src/product/model-admission-state.ts`
- Modify: `apps/web/src/product/ModelAdmissionPage.tsx`
- Test: `packages/contracts/src/model-admission.test.ts`
- Test: `apps/remote/test/model/ollama-admission-adapter.test.ts`
- Test: `apps/web/src/product/model-admission-state.test.ts`

- [x] **Step 1: 写合同失败测试**

```ts
expect(parseModelStudentCandidateInput({
  presetId: "ollama",
  displayName: "本机千问",
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen3:8b",
})).not.toHaveProperty("apiKey");
```

- [x] **Step 2: 扩展协议与预设**

```ts
type ProviderProtocol = "ollama_native" | "openai_responses" |
  "openai_chat_completions" | "anthropic_messages";
```

Ollama 预设为 editable baseUrl、auth `none`，仅允许 `localhost`、`127.0.0.1`、`::1`，允许 HTTP。

- [x] **Step 3: 实现 Ollama Adapter**

Adapter 使用 `OllamaProvider.verify()` 读取真实 `/api/tags`；快照声明其实际 streaming、tool continuation、usage、thought 与 toggle reasoning 能力。

- [x] **Step 4: 安装事务允许无凭据 Connection**

`credentialRef` 和 `credentialHint` 变成可选；只有候选带 API Key 时才写入或删除 SecretStore。

- [x] **Step 5: Web 根据 auth.scheme 控制 API Key 字段**

Ollama 不显示 API Key，固定云端预设维持当前行为。

- [x] **Step 6: 运行合同、Adapter、Web 状态测试**

Run: `pnpm --filter @kindergarten/contracts test && pnpm --filter @kindergarten/remote test -- test/model/ollama-admission-adapter.test.ts && pnpm --filter @kindergarten/web test -- src/product/model-admission-state.test.ts`

Expected: PASS。

### Task 4: 允许零模型启动并按 Session 解析 Provider

**Files:**
- Modify: `apps/remote/src/model/model-student-catalog.ts`
- Modify: `apps/remote/src/capability/runtime-capability-resolver.ts`
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/src/acp/kindergarten-agent.ts`
- Modify: `apps/remote/src/index.ts`
- Test: `apps/remote/test/model/model-student-catalog.test.ts`
- Test: `apps/remote/test/runtime/runtime-capability-resolver.test.ts`
- Test: `apps/remote/test/acp-session.test.ts`

- [x] **Step 1: 写空目录测试**

```ts
const catalog = new ModelStudentCatalog();
expect(catalog.all()).toEqual([]);
expect(() => catalog.requireProvider("missing")).toThrow("不存在");
```

- [x] **Step 2: 删除 Catalog 默认 ID**

构造函数不再注册 Provider；`verify(id)` 必须显式传入；删除 `defaultProvider()`。

- [x] **Step 3: Runtime 生产组装不再持有 fallback ModelProvider**

`AgentRuntime` 允许无 fallback；带 TurnScope 的正式调用必须由 `RuntimeCapabilityResolver` 返回模型，否则明确失败。

- [x] **Step 4: ACP reasoning 只查询 Catalog**

Session 绑定模型不存在或不可用时，历史仍可 load；prompt 明确返回模型不可用，不切换其他模型。

- [x] **Step 5: Remote 以空 Catalog 启动**

删除 `createStudent()`、启动时 `new OllamaProvider()` 和强制体检；恢复受管入园记录后才出现可选模型。

- [x] **Step 6: 运行 Catalog、Resolver、ACP 测试**

Run: `pnpm --filter @kindergarten/remote test -- test/model/model-student-catalog.test.ts test/runtime/runtime-capability-resolver.test.ts test/acp-session.test.ts`

Expected: PASS。

### Task 5: 迁移旧内置 Ollama 与统一删除语义

**Files:**
- Create: `apps/remote/src/model/legacy-ollama-migration.ts`
- Modify: `apps/remote/src/model/model-admission-repository.ts`
- Modify: `apps/remote/src/model/model-admission-service.ts`
- Modify: `apps/remote/src/index.ts`
- Test: `apps/remote/test/model/legacy-ollama-migration.test.ts`
- Test: `apps/remote/test/model/model-admission-service.test.ts`

- [x] **Step 1: 写幂等迁移测试**

旧 Session 引用 `local-coder-student` 时，以原 ID 创建普通 `ollama` 受管记录；重复运行不重复写入。

- [x] **Step 2: 实现一次性迁移**

仅在旧 Session 引用存在且目录没有同 ID 模型时读取旧 `OLLAMA_URL`、`OLLAMA_MODEL` 等变量；不启动 Ollama，不自动下载模型。

- [x] **Step 3: 增加 archived 生命周期**

被 Session 引用的模型删除请求改为 archived：Catalog 保留不可用元数据并释放 Provider；未被引用时硬删除记录和凭据。

- [x] **Step 4: 运行迁移和删除测试**

Run: `pnpm --filter @kindergarten/remote test -- test/model/legacy-ollama-migration.test.ts test/model/model-admission-service.test.ts`

Expected: PASS。

### Task 6: 移除小模型专属重复无效工具调用保护

**Files:**
- Delete: `apps/remote/src/runtime/repeated-invalid-tool-call-guard.ts`
- Delete: `apps/remote/test/runtime/repeated-invalid-tool-call-guard.test.ts`
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/src/tools/tool-runtime.ts`
- Modify: `apps/remote/test/runtime.test.ts`
- Modify: `apps/remote/src/index.ts`

- [x] **Step 1: 把行为测试改为模型大小无关**

同样的无效参数仍作为 ToolOutcome 反馈给模型，由通用模型轮数和资源上限收口，不产生 small/large 分支。

- [x] **Step 2: 删除 Factory、inspect 和专用失败码路径**

- [x] **Step 3: 运行 Runtime 测试**

Run: `pnpm --filter @kindergarten/remote test -- test/runtime.test.ts`

Expected: PASS。

### Task 7: 合并 Evaluation Web

**Files:**
- Move: `apps/evaluation-web/src/*` → `apps/web/src/evaluation/*`
- Delete: `apps/web/src/evaluation/main.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/product/ContextLabPage.tsx`
- Delete: `apps/evaluation-web/package.json`
- Delete: `apps/evaluation-web/index.html`
- Delete: `apps/evaluation-web/tsconfig.json`
- Delete: `apps/evaluation-web/vite.config.ts`

- [x] **Step 1: 移动页面、样式与测试**

保持 Evaluation 内部相对导入不变，在 `evaluation/App.tsx` 引入 `styles.css`。

- [x] **Step 2: 根路由延迟加载**

```tsx
const EvaluationApp = lazy(() => import("./evaluation/App.js"));
if (path.startsWith("/evaluation/")) {
  return <Suspense fallback={...}><EvaluationApp /></Suspense>;
}
```

- [x] **Step 3: 合并依赖并删除第二个 app package**

`@kindergarten/evaluation-contract` 加入 Web；保留 ACP SDK、React 和 lucide 的单份依赖。

- [x] **Step 4: 运行 Web 测试和构建**

Run: `pnpm --filter @kindergarten/web test && pnpm --filter @kindergarten/web build`

Expected: PASS，只生成一个 Web dist。

### Task 8: 同源 API、ACP 与 Evaluation 代理

**Files:**
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/api/control-api.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/evaluation/api.ts`
- Modify: `apps/web/src/evaluation/experiment-api.ts`
- Modify: `apps/web/src/evaluation/experiment/ExperimentEvaluationPage.tsx`
- Create: `apps/remote/src/server/evaluation-proxy.ts`
- Modify: `apps/remote/src/server/http-server.ts`
- Test: `apps/remote/test/server/evaluation-proxy.test.ts`

- [x] **Step 1: 写 Evaluation Proxy 测试**

`GET /api/evaluation/v1/turn-evaluations/a/b` 只能转发到配置的 Evaluation Origin，并保留状态与安全响应头。

- [x] **Step 2: Vite 代理 `/api` 与 `/acp`**

浏览器默认 Control URL 为 `/api/control/v1`；ACP URL 从当前页面协议和 host 生成。

- [x] **Step 3: Evaluation 页面只请求 `/api/evaluation/v1`**

删除 7441 和 5175 的浏览器硬编码。

- [x] **Step 4: 运行代理与 Web 测试**

Run: `pnpm --filter @kindergarten/remote test -- test/server/evaluation-proxy.test.ts && pnpm --filter @kindergarten/web test`

Expected: PASS。

### Task 9: 健康检查、脚本与仓库约束收口

**Files:**
- Modify: `apps/remote/src/server/http-server.ts`
- Modify: `apps/evaluation-service/src/server.ts`
- Modify: `apps/evaluation-service/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `AGENTS.md`
- Test: `apps/remote/test/websocket.test.ts`
- Test: `apps/evaluation-service/test/server.test.ts`

- [x] **Step 1: 增加 live / ready**

Remote readiness 检查数据目录、Catalog 和 SecretStore 初始化；Evaluation readiness 检查 Repository。

- [x] **Step 2: 收口根脚本**

```json
{
  "dev": "1 web + remote + evaluation-service",
  "build": "1 web + 2 Node bundle",
  "start:dist": "remote + evaluation-service dist"
}
```

- [x] **Step 3: 增加 Evaluation `start:dist`**

Run: `node --env-file-if-exists=../../.env dist/index.js`

- [x] **Step 4: 更新仓库约束**

明确 Ollama 是可选入园 Provider，不再是默认启动依赖；单 Web 是当前规范。

- [x] **Step 5: 运行健康检查测试**

Run: `pnpm --filter @kindergarten/remote test -- test/websocket.test.ts && pnpm --filter @kindergarten/evaluation-service test -- test/server.test.ts`

Expected: PASS。

### Task 10: 全量验收

**Files:**
- Modify: 本计划复选框

- [x] **Step 1: 类型检查**

Run: `pnpm typecheck`

Expected: 所有 workspace PASS，不再包含 `@kindergarten/evaluation-web`。

- [x] **Step 2: 全量测试**

Run: `pnpm test`

Expected: PASS。

- [x] **Step 3: 全量构建**

Run: `pnpm build`

Expected: 一个浏览器静态产物、两个 Node ESM bundle。

- [x] **Step 4: 零模型启动冒烟**

使用空临时 `DATA_DIR` 启动三进程；Remote ready、首页和模型入园页可访问，未启动 Ollama 时 Remote 不退出。

- [x] **Step 5: 同源链路冒烟**

通过 5173 访问 `/`、`/evaluation/*`、`/api/control/v1/model-students` 和 `/acp`，浏览器不直接访问 7331/7441。

---

## 不在本计划伪装完成的事项

```text
真实多用户账号系统
└─ 需要 ACP WebSocket 连接级 Principal 与 Session owner 重新建模；
   本阶段只保留现有 local-admin，并完成可替换身份边界。

Docker / 云端加密文件 SecretStore
└─ 第二阶段实现；本阶段保证业务记录已不依赖 keychain 名称。

Docker / Compose / CI/CD / Linux Runner
└─ 全部属于第二阶段。
```
