# Evaluation 模块合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Evaluation 从独立应用合并为同一 Node 进程中的 `Evaluation` 模块，保留异步故障隔离、评测合同、文件存储、浏览器接口和测试边界。

**Architecture:** `apps/remote/src/evaluation/` 直接拥有 Trace 收集、评分、Repository 和只读 HTTP API。Agent Turn 只向有界后台任务提交终态 Trace；持久化失败只记录评测降级，不改变 Turn 结果。浏览器继续使用 `/api/evaluation/v1`，不再经过独立端口和 HTTP 代理。

**Tech Stack:** TypeScript、Node.js 22、Vitest、pnpm workspace、esbuild、React/Vite

---

### Task 1: 建立 Evaluation 模块核心

**Files:**
- Create: `apps/remote/src/evaluation/evaluator.ts`
- Create: `apps/remote/src/evaluation/repository.ts`
- Create: `apps/remote/src/evaluation/trace-migration.ts`
- Create: `apps/remote/src/evaluation/trace-collector.ts`
- Create: `apps/remote/src/evaluation/evaluation-module.ts`
- Test: `apps/remote/test/evaluation/evaluation-module.test.ts`
- Test: `apps/remote/test/evaluation/trace-collector.test.ts`

- [ ] **Step 1: 先迁移并调整失败用例**

覆盖以下合同：

```ts
const evaluation = new EvaluationModule(dir);
await evaluation.initialize();
evaluation.emit(turnCompletedEvent);
await evaluation.flush();
expect(await evaluation.get("session", "turn")).toMatchObject({
  result: { normallyCompleted: true },
});
```

同时验证：后台写入失败不从 `emit` 抛出；队列达到容量时丢弃评测副本并记录警告；`flush` 等待在途写入；`takeTrace` 只返回一次。

- [ ] **Step 2: 运行 Evaluation 定向测试，确认新模块尚不存在**

Run: `pnpm --filter @kindergarten/remote test -- test/evaluation`

Expected: FAIL，原因是 `src/evaluation/evaluation-module.ts` 尚不存在。

- [ ] **Step 3: 实现最小模块**

核心接口：

```ts
export interface EvaluationRecordReader {
  get(sessionId: string, turnId: string): Promise<TurnEvaluationRecord | undefined>;
}

export class EvaluationModule implements RuntimeObservationSink, EvaluationRecordReader {
  constructor(dataDir: string);
  initialize(): Promise<void>;
  emit(event: RuntimeObservationEvent): void;
  flush(): Promise<void>;
  takeTrace(sessionId: string, turnId: string): TurnTraceDocument | undefined;
  get(sessionId: string, turnId: string): Promise<TurnEvaluationRecord | undefined>;
  fetch(request: Request): Promise<Response | undefined>;
  get available(): boolean;
}
```

`TraceCollector` 在终态事件后调用受控异步 `save(document)`；`EvaluationModule` 用 `evaluateTurn(document)` 生成结果并通过 `EvaluationRepository.put` 原子写入。

- [ ] **Step 4: 运行定向测试**

Run: `pnpm --filter @kindergarten/remote test -- test/evaluation`

Expected: PASS。

---

### Task 2: 浏览器评测接口改为进程内读取

**Files:**
- Modify: `apps/remote/src/server/http-server.ts`
- Delete: `apps/remote/src/server/evaluation-api-proxy.ts`
- Delete: `apps/remote/test/server/evaluation-api-proxy.test.ts`
- Test: `apps/remote/test/evaluation/evaluation-api.test.ts`

- [ ] **Step 1: 写直接读取接口测试**

```ts
const response = await evaluation.fetch(
  new Request("http://remote/api/evaluation/v1/turn-evaluations/s-1/t-1"),
);
expect(response?.status).toBe(200);
```

测试还要覆盖非评测路径返回 `undefined`、写请求返回 `405`、记录不存在返回 `404`、模块不可用返回 `503`。

- [ ] **Step 2: 将 RemoteServer 的评测依赖改为通用 Fetch Handler**

```ts
export interface HttpFeature {
  fetch(request: Request): Promise<Response | undefined>;
}
```

RemoteServer 在 Control API 前调用 `evaluation.fetch(request)`，不再做跨进程地址转换。

- [ ] **Step 3: 删除代理实现和代理测试**

确认仓库中不存在 `EvaluationApiProxy`。

- [ ] **Step 4: 运行服务层测试**

Run: `pnpm --filter @kindergarten/remote test -- test/evaluation test/websocket.test.ts`

Expected: PASS。

---

### Task 3: 接入 Remote 启动与 Experiment

**Files:**
- Modify: `apps/remote/src/index.ts`
- Modify: `apps/remote/src/experiments/experiment-service.ts`
- Modify: `apps/remote/test/experiments/experiment-service.test.ts`
- Delete: `apps/remote/src/experiments/evaluation-record-client.ts`
- Modify: `apps/remote/src/config/deployment-config.ts`
- Modify: `apps/remote/test/config/deployment-config.test.ts`

- [ ] **Step 1: 将 Experiment 依赖收敛为模块合同**

```ts
interface EvaluationAccess extends EvaluationRecordReader {
  flush(): Promise<void>;
  takeTrace(sessionId: string, turnId: string): TurnTraceDocument | undefined;
}
```

`ExperimentService` 只依赖该合同，不依赖 HTTP Client 或 Exporter 具体类。

- [ ] **Step 2: 在入口初始化 Evaluation**

```ts
const evaluation = new EvaluationModule(resolve(dataDir, "evaluation"));
await evaluation.initialize();
```

同一个实例传给 `AgentRuntime`、`ExperimentService` 和 `RemoteServer`。退出时与 MCP、Server 一起 `flush`。

- [ ] **Step 3: 删除独立服务 URL 配置**

从 `DeploymentConfig` 删除 `evaluationUrl`，删除 `EVALUATION_SERVICE_URL`。

- [ ] **Step 4: 运行入口相关测试**

Run: `pnpm --filter @kindergarten/remote test`

Expected: Remote 全部测试通过。

---

### Task 4: 删除独立应用和 Exporter package

**Files:**
- Delete: `apps/evaluation-service/**`
- Delete: `packages/evaluation-exporter/**`
- Modify: `apps/remote/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.env.example`

- [ ] **Step 1: 删除独立 workspace**

删除 Evaluation Service 的入口、HTTP Server、Repository 副本、测试和 package；删除只为跨进程上传存在的 Exporter package。

- [ ] **Step 2: 收敛根命令**

```json
{
  "dev": "pnpm --parallel --filter @kindergarten/remote --filter @kindergarten/web dev",
  "start:dist": "pnpm --filter @kindergarten/remote start:dist"
}
```

删除 `dev:evaluation`；Evaluation 页面仍由 Web 开发命令提供。

- [ ] **Step 3: 更新依赖和锁文件**

Remote 直接依赖 `@kindergarten/evaluation-contract` 和 `@kindergarten/runtime-observation`。运行 `pnpm install --lockfile-only` 更新 workspace importer。

- [ ] **Step 4: 搜索残留运行引用**

Run: `rg 'evaluation-service|EvaluationApiProxy|EvaluationRecordClient|EvaluationTraceExporter|EVALUATION_SERVICE_URL|7441' apps packages package.json .env.example`

Expected: 无运行代码残留。

---

### Task 5: 同步产品与架构文档

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TECHNICAL_PLAN.md`
- Modify: `docs/TURN_EVALUATION.md`
- Modify: `docs/REASONING_POLICY.md`
- Modify: `docs/DEMO_TO_PRODUCTION_TRD.md`
- Modify: `docs/DEMO_TO_PRODUCTION_IMPLEMENTATION_STATUS.md`
- Modify: `docs/ONLINE_DEPLOYMENT_RESEARCH_TRD.md`
- Modify: `docs/SKILL_INSTALL_FAILURE_RECOVERY_TRD.md`
- Modify: `docs/2026-08-10-models-kindergarten-demo-app-spec.md`
- Modify: `AGENTS.md`
- Modify: Codex outputs 中全部 MK 架构文档

- [ ] **Step 1: 统一术语**

只写“Evaluation 模块”，不写“Remote 内置 Evaluation 模块”。删除独立服务、7441、内部令牌、独立容器、独立镜像和独立数据卷。

- [ ] **Step 2: 更新部署图**

目标运行单元：

```text
自有 mk-app 镜像
└─ mk-app 容器（Web + Remote + Evaluation 模块）

官方 Caddy 镜像
└─ mk-gateway 容器

官方 ONLYOFFICE 镜像
└─ mk-onlyoffice 容器
```

MK 只构建一个 `mk-app` 镜像；Caddy 和 ONLYOFFICE 直接使用官方镜像。云端共三个容器、三个镜像来源，但只有一个镜像由 MK 构建和发布。

- [ ] **Step 3: 用人话解释安全与发布概念**

文档必须直接解释主密钥文件为何不能让非服务用户读取、`0444` 的含义、HTTP Principal、登录密钥/公开域名/TLS、Linux 工具能力与 Tool Call 的关系，以及不可变镜像摘要的含义。

---

### Task 6: 全量验证

**Files:**
- Verify only

- [ ] **Step 1: 类型检查**

Run: `pnpm typecheck`

Expected: 全 workspace PASS。

- [ ] **Step 2: 测试**

Run: `pnpm test`

Expected: 全 workspace PASS；测试数量按删除独立 HTTP 边界和迁入 Remote 后重新统计。

- [ ] **Step 3: 构建**

Run: `pnpm build`

Expected: 一个 Web 静态产物、一个 Remote Node ESM bundle。

- [ ] **Step 4: dist 冒烟测试**

运行 `pnpm start:dist`，验证 `/health/live`、`/health/ready` 和 `/api/evaluation/v1/...`，然后正常退出。

- [ ] **Step 5: 最终残留扫描**

Run: `rg 'evaluation-service|Evaluation Service|EvaluationApiProxy|EvaluationRecordClient|EvaluationTraceExporter|EVALUATION_SERVICE_URL|7441' --glob '!docs/superpowers/**'`

Expected: 活跃代码与当前架构文档无独立服务残留；历史执行计划不作为当前架构入口。

---

本任务在用户现有脏工作树上执行，不创建提交，不改动无关的未跟踪文件。
