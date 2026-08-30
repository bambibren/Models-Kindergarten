# Local Source Managed Endpoint Network Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让源码本地开发环境自动取消受管 Model/MCP 端点的公网 IP 限制，同时保证 Docker 预演和云端继续执行严格公网校验，并保留不能移除的网络安全边界。

**Architecture:** `DeploymentConfig.profile` 是唯一环境事实；由它派生 `managedEndpointPolicy`，`local-source` 为 `any-network`，`docker-preview`/`cloud` 为 `public-only`。该策略只注入用户显式配置的 Model Provider 和 Remote MCP，不注入由模型自行决定目标地址的 `web_fetch`，避免本地 Agent 借工具访问 Remote Control API、宿主服务或局域网设备。

**Tech Stack:** TypeScript 7、Node.js 22 DNS/HTTP、Vitest 4、pnpm 11、现有 `PinnedHttpTransport` 与 MCP SDK Transport。

---

## 扫描结论与变更边界

| 网络校验入口 | 本地源码 `local-source` | Docker/云端 | 处理决定 |
| --- | --- | --- | --- |
| Model Provider Base URL 的公网/私网/保留 IP 判断 | 取消 | 保留 | 修改；这是本次 VPN Fake-IP 误判来源 |
| Remote MCP 的公网/私网 IP 判断 | 取消 | 保留 | 修改；MCP 地址由本地用户受管配置 |
| Model/MCP URL 语法、URL 内凭据、HTTPS 要求 | 保留 | 保留 | 不可移除；避免错误寻址与 API Key 明文/日志泄漏；本地 Ollama 走独立协议 |
| Model/MCP 重定向限制 | 保留 | 保留 | 不可移除；避免 Bearer Token 被转发到另一主机 |
| `web_fetch` 的本机/私网阻断 | 保留 | 保留 | 不可移除；目标由模型选择，本地开发身份可直接访问 Control API，移除会形成工具越权 |
| Skill 来源 origin、路径和 Git HTTPS 校验 | 保留 | 保留 | 不可移除；这是用户授权来源与安装边界，不是环境 IP 校验 |
| 响应大小、超时、并发和熔断 | 保留 | 保留 | 不可移除；防止 ToolRuntime 资源失控 |
| `local-source` 只监听 loopback、Control Origin 校验 | 保留 | 保留 | 不可移除；防止开发服务暴露到局域网并维持 Browser/Remote 边界 |
| 云部署命令的公网 IP 校验 | 不适用 | 保留 | 不可移除；只在执行云部署命令时验证目标，不参与本地 Runtime |

### Task 1: 由部署配置统一派生受管端点网络策略

**Files:**
- Modify: `apps/remote/src/config/deployment-config.ts`
- Test: `apps/remote/test/config/deployment-config.test.ts`

- [x] **Step 1: 写入失败测试，固定三种 profile 的策略**

在默认本地配置断言：

```ts
expect(config).toMatchObject({
  profile: "local-source",
  managedEndpointPolicy: "any-network",
});
```

在 Docker 和 Cloud 场景分别断言：

```ts
expect(readDeploymentConfig({
  DEPLOYMENT_PROFILE: "docker-preview",
  PUBLIC_ORIGIN: "https://mk.localhost:8443",
})).toMatchObject({ managedEndpointPolicy: "public-only" });

expect(readDeploymentConfig({
  DEPLOYMENT_PROFILE: "cloud",
  PUBLIC_ORIGIN: "https://mk.example.com",
})).toMatchObject({ managedEndpointPolicy: "public-only" });
```

- [x] **Step 2: 运行配置测试并确认失败**

Run:

```bash
pnpm --filter @kindergarten/remote exec vitest run test/config/deployment-config.test.ts
```

Expected: FAIL，提示 `managedEndpointPolicy` 缺失。

- [x] **Step 3: 在部署配置中加入只读派生事实**

加入类型和字段：

```ts
export type ManagedEndpointPolicy = "any-network" | "public-only";

export interface DeploymentConfig {
  profile: DeploymentProfile;
  managedEndpointPolicy: ManagedEndpointPolicy;
  // 其余字段保持不变
}
```

在 `readDeploymentConfig` 返回值中由 profile 唯一派生，不新增可漂移的环境变量：

```ts
managedEndpointPolicy: profile === "local-source" ? "any-network" : "public-only",
```

- [x] **Step 4: 运行配置测试并确认通过**

Run:

```bash
pnpm --filter @kindergarten/remote exec vitest run test/config/deployment-config.test.ts
```

Expected: PASS。

### Task 2: Model URL 策略在本地只取消 IP 网络分类

**Files:**
- Modify: `apps/remote/src/model/remote-model-url-policy.ts`
- Modify: `apps/remote/src/index.ts`
- Test: `apps/remote/test/model/remote-model-url-policy.test.ts`
- Mechanical test updates: every test constructing `new RemoteModelUrlPolicy(fakeLookup)` under `apps/remote/test/model/`

- [x] **Step 1: 写入本地 Fake-IP 与 loopback 通过、线上仍拒绝的失败测试**

新增本地策略测试：

```ts
it("本地受管端点接受 VPN Fake-IP 和 loopback，但仍要求 HTTPS 且禁止 URL 凭据", async () => {
  const policy = new RemoteModelUrlPolicy({
    allowPrivateNetwork: true,
    lookup: async () => [{ address: "198.18.0.120", family: 4 }],
  });
  await expect(policy.resolve("https://sub.deuo.top")).resolves.toMatchObject({
    addresses: [{ address: "198.18.0.120", family: 4 }],
  });
  await expect(policy.resolve("https://127.0.0.1/v1")).resolves.toMatchObject({
    addresses: [{ address: "127.0.0.1", family: 4 }],
  });
  await expect(policy.resolve("http://sub.deuo.top")).rejects.toMatchObject({ reason: "not_allowed" });
  await expect(policy.resolve("https://user:pass@sub.deuo.top")).rejects.toMatchObject({ reason: "not_allowed" });
});
```

保留并继续运行现有默认严格测试，证明未显式放宽时 `198.18.0.120`、loopback、私网仍被拒绝。

- [x] **Step 2: 运行 Model URL 测试并确认失败**

Run:

```bash
pnpm --filter @kindergarten/remote exec vitest run test/model/remote-model-url-policy.test.ts
```

Expected: FAIL，因为构造器尚不支持策略选项。

- [x] **Step 3: 给 Model URL 策略增加显式、默认严格的选项**

把构造器收敛为对象参数：

```ts
export interface RemoteModelUrlPolicyOptions {
  lookup?: RemoteModelLookup;
  allowPrivateNetwork?: boolean;
}

export class RemoteModelUrlPolicy {
  private readonly lookup: RemoteModelLookup;
  private readonly allowPrivateNetwork: boolean;

  constructor(options: RemoteModelUrlPolicyOptions = {}) {
    this.lookup = options.lookup ?? (async (hostname) =>
      dnsLookup(hostname, { all: true, verbatim: true }));
    this.allowPrivateNetwork = options.allowPrivateNetwork === true;
  }
}
```

仅用 `allowPrivateNetwork` 包住三处网络分类拒绝：非公网 hostname、IP literal、DNS 结果。URL 解析、HTTPS、URL 凭据、DNS 失败、地址格式校验继续执行；`PinnedHttpTransport` 仍使用本次 DNS 结果，避免改变请求路径与 TLS SNI。

- [x] **Step 4: 机械更新测试 Lookup 注入写法**

把：

```ts
new RemoteModelUrlPolicy(async () => [{ address: "8.8.8.8" }])
```

统一改为：

```ts
new RemoteModelUrlPolicy({ lookup: async () => [{ address: "8.8.8.8" }] })
```

- [x] **Step 5: 在启动组装层按 profile 注入策略**

在 `apps/remote/src/index.ts` 使用部署配置唯一决定行为：

```ts
const allowManagedPrivateNetwork = deployment.managedEndpointPolicy === "any-network";
const modelUrlPolicy = new RemoteModelUrlPolicy({
  allowPrivateNetwork: allowManagedPrivateNetwork,
});
```

不在 Model Provider、Admission Adapter 或浏览器请求中再次读取环境变量。

- [x] **Step 6: 运行 Model/Admission/Provider 相关测试**

Run:

```bash
pnpm --filter @kindergarten/remote exec vitest run \
  test/model/remote-model-url-policy.test.ts \
  test/model/model-admission-service.test.ts \
  test/model/model-admission-acp-integration.test.ts \
  test/model/pinned-http-transport.test.ts \
  test/responses-api-provider.test.ts \
  test/chat-completions-provider.test.ts
```

Expected: PASS。

### Task 3: Remote MCP 在本地源码环境取消私网 IP 判断

**Files:**
- Modify: `apps/remote/src/mcp/sdk-mcp-connector.ts`
- Modify: `apps/remote/src/index.ts`
- Test: `apps/remote/test/capabilities.test.ts`

- [x] **Step 1: 增加本地 MCP 网络策略测试**

在现有 MCP 网络策略测试中加入：

```ts
await expect(assertMcpUrl(new URL("https://192.168.1.5/mcp"), true)).resolves.toBeUndefined();
await expect(assertMcpUrl(new URL("http://192.168.1.5/mcp"), true)).rejects.toThrow("只允许 HTTPS");
await expect(assertMcpUrl(new URL("https://user:pass@192.168.1.5/mcp"), true)).rejects.toThrow("认证信息");
```

这固定“本地只取消 IP 分类；协议与凭据边界不取消”。

- [x] **Step 2: 给 SDK Connector 增加部署级默认值**

加入选项：

```ts
export interface SdkMcpConnectorOptions {
  allowPrivateNetwork?: boolean;
}

constructor(
  private readonly secrets: SecretStore,
  private readonly sandboxRoot: string,
  private readonly options: SdkMcpConnectorOptions = {},
) {}
```

创建 fetch 时合并部署级与单 Server 显式配置：

```ts
fetch: createMcpFetch(
  this.options.allowPrivateNetwork === true || server.transport.allowPrivateNetwork === true,
),
```

- [x] **Step 3: 在启动组装层注入相同部署事实**

```ts
new SdkMcpConnector(secrets, sandbox.root, {
  allowPrivateNetwork: allowManagedPrivateNetwork,
})
```

线上仍默认 false；历史单个 loopback MCP 的 `allowPrivateNetwork` 配置继续兼容。

- [x] **Step 4: 运行 MCP 与能力测试**

Run:

```bash
pnpm --filter @kindergarten/remote exec vitest run \
  test/capabilities.test.ts \
  test/mcp/mcp-config-store.test.ts \
  test/mcp/mcp-management.test.ts
```

Expected: PASS。

### Task 4: 固化审计结论并完成全量验证

**Files:**
- Modify: `docs/VALIDATION_AND_FALLBACK_AUDIT.md`
- Verify only: `.env.example`, `deploy/env/preview.env.example`, `deploy/env/cloud-ip.env.example`, `deploy/env/cloud-domain.env.example`

- [x] **Step 1: 在审计文档增加 2026-08-30 环境网络策略章节**

写明以下结论：

```md
## 2026-08-30 受管端点环境策略补充

- `local-source`：Model Provider 与 Remote MCP 不做公网/私网/保留 IP 分类；允许 VPN Fake-IP、loopback 和局域网地址。
- `docker-preview`、`cloud`：Model Provider 与 Remote MCP 继续只允许公网目标。
- 所有环境继续验证 URL 语法、URL 凭据、协议、重定向、响应大小和超时。
- `web_fetch` 始终阻止本机和私网，因为目标由模型选择；本地开发身份可访问 Control API，取消会形成工具越权。
- Skill 来源白名单、文件沙箱、服务监听地址和 Cloud 部署目标校验不属于本地出站 IP 兼容问题，继续保留。
```

- [x] **Step 2: 静态验证 profile 配置没有串线**

Run:

```bash
rg -n "DEPLOYMENT_PROFILE=" .env.example deploy/env/*.env.example
```

Expected:

```text
.env.example: DEPLOYMENT_PROFILE=local-source
deploy/env/preview.env.example: DEPLOYMENT_PROFILE=docker-preview
deploy/env/cloud-*.env.example: DEPLOYMENT_PROFILE=cloud
```

- [x] **Step 3: 用本机当前 Fake-IP 做无 Secret 的策略验证**

Run:

```bash
pnpm --filter @kindergarten/remote exec tsx -e '
import { RemoteModelUrlPolicy } from "./src/model/remote-model-url-policy.ts";
const policy = new RemoteModelUrlPolicy({ allowPrivateNetwork: true });
policy.resolve("https://sub.deuo.top").then((value) => console.log(value.addresses));
'
```

Expected: 成功输出当前系统解析结果，包括 `198.18.0.120`，不再报“私网或保留地址”。

- [x] **Step 4: 运行全仓库验证**

Run:

```bash
CI=true pnpm check
```

Expected: typecheck、全部测试、全部 build 通过。

- [x] **Step 5: 启动验证配置选择**

重启源码 Remote 后检查启动日志：

```bash
curl -fsS http://127.0.0.1:7331/health/ready
```

Expected: `ok: true`；源码 Remote 使用 `local-source / any-network`。Docker 预演的 `DEPLOYMENT_PROFILE=docker-preview` 保持 `public-only`，不修改其数据或凭据。

## Self-Review

- Spec coverage: 已覆盖本地自动识别、Model/MCP IP 校验取消、Docker/云端严格保留、全面扫描、不能取消项及原因、协议测试和真实 Fake-IP 验证。
- Placeholder scan: 无 TBD、TODO、“类似处理”或未定义类型；每一步包含明确文件、代码和命令。
- Type consistency: `managedEndpointPolicy` 只由 `DeploymentConfig` 定义；启动层统一派生 `allowManagedPrivateNetwork` 并分别传给 Model 与 MCP；`web_fetch` 不接收该值。
