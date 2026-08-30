# ONLYOFFICE Preview Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让生产认证模式下的 ONLYOFFICE DocumentServer 能凭短时签名票据读取 PPTX，并让浏览器静态预览使用同源内容地址。

**Architecture:** Remote HTTP 外层认证和 Control API 内层认证只放行形如 `/api/control/v1/onlyoffice/artifacts/:artifactId/raw` 的读取请求，实际访问仍由 `OnlyOfficePreviewService.verify()` 校验 token。Artifact 预览响应返回同源相对 URL，避免把 Remote 容器内部 origin 暴露给浏览器；Web 静态预览继续保持现有降级界面，并在捕获异常时输出原始错误。

**Tech Stack:** TypeScript、Node.js HTTP、Vitest、React

---

### Task 1: 放行 ONLYOFFICE 签名读取请求

**Files:**
- Modify: `apps/remote/src/server/http-server.ts:190-195`
- Modify: `apps/remote/src/server/control-api.ts`
- Test: `apps/remote/test/websocket.test.ts`

- [ ] **Step 1: 写入失败测试**

在认证模式的真实 HTTP Server 测试中，让外层和 Control API 内层认证器都拒绝无 Cookie 请求。断言签名读取路由绕过两层 Cookie 认证并进入 Control API，而普通 Artifact 路由仍返回 401。

```ts
expect((await fetch(`${base}/api/control/v1/onlyoffice/artifacts/artifact-a/raw?token=ticket`)).status).toBe(200);
expect((await fetch(`${base}/api/control/v1/artifacts/artifact-a/raw`)).status).toBe(401);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @kindergarten/remote test -- websocket.test.ts`

Expected: ONLYOFFICE 路由实际返回 401，新增断言失败。

- [ ] **Step 3: 实现精确路径放行**

```ts
return path === "/api/control/v1/auth/login" ||
  path === "/api/control/v1/auth/session" ||
  path === "/api/control/v1/auth/logout" ||
  /^\/api\/control\/v1\/onlyoffice\/artifacts\/[^/]+\/raw$/.test(path);
```

Control API 对去掉 `/api/control/v1` 前缀后的同一路径执行同样匹配，并继续让其他 Artifact 请求解析登录身份。

- [ ] **Step 4: 运行定向测试并确认通过**

Run: `pnpm --filter @kindergarten/remote test -- websocket.test.ts`

Expected: `websocket.test.ts` 全部通过。

### Task 2: 保留静态 PPTX 预览异常

**Files:**
- Modify: `apps/remote/src/artifacts/artifact-routes.ts`
- Test: `apps/remote/test/artifacts/onlyoffice-preview-route.test.ts`
- Modify: `apps/web/src/components/artifacts/PptxPreview.tsx:87-89`

- [ ] **Step 1: 让预览内容地址保持同源**

```ts
service.preview(params.artifactId ?? "", principal.principalId)
```

路由使用 `ArtifactService.preview()` 的默认 `/api/control/v1` 相对 base，不根据 Remote 收到的内部 HTTP 请求拼接绝对地址。

- [ ] **Step 2: 输出捕获到的实际异常**

```ts
} catch (error) {
  console.error("PPTX 静态预览失败", error);
  if (active && !controller.signal.aborted) setState({ phase: "error" });
}
```

- [ ] **Step 3: 验证类型、测试与构建**

Run: `pnpm --filter @kindergarten/web typecheck && pnpm --filter @kindergarten/web test && pnpm --filter @kindergarten/web build`

Expected: 三条命令均以退出码 0 完成。

### Task 3: 发布与生产验证

**Files:**
- No source file changes

- [ ] **Step 1: 运行受影响范围验证**

Run: `pnpm --filter @kindergarten/remote typecheck && pnpm --filter @kindergarten/remote test -- websocket.test.ts && pnpm --filter @kindergarten/web typecheck && pnpm --filter @kindergarten/web test && pnpm --filter @kindergarten/web build`

Expected: 所有命令以退出码 0 完成。

- [ ] **Step 2: 使用仓库生产部署脚本发布**

Run: `pnpm deploy:cloud:domain`

Expected: 新 release 健康检查通过并切换为当前生产版本。

- [ ] **Step 3: 验证目标 Session 的播放链路**

打开生产 Session `93f9bb27-1854-42f1-b6e1-1d382ffc6a6d`，启动 PPTX 动画播放，并确认 DocumentServer 取件不再返回 401。
