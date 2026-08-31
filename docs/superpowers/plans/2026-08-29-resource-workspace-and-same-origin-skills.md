# Resource 工作区与 Skills 同源访问实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Skill 演示资源纳入 MK 主仓库的 `resource/` 工作区，并让源码开发、Docker 预演和云端生产统一使用 `/skills/{name}` 地址。

**Architecture:** 源码开发由 `resource` Node 服务监听 7342，Vite 在 5173 代理 `/skills/*`；Docker 与云端由 `mk-web` 中的 Caddy 直接提供同一路径。Web 根据 `window.location.origin` 生成公开地址，Remote 校验公开源站后通过独立的内部下载基址获取资源。

**Tech Stack:** pnpm workspace、Node.js 22、Vite、TypeScript、Vitest、Caddy、Docker Compose。

---

### Task 1: Resource 工作区

**Files:**
- Create: `resource/package.json`
- Create: `resource/server.mjs`
- Create: `resource/test/server.test.mjs`
- Create: `resource/skills/pptx/*`
- Create: `resource/skills/website-design-fast/*`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`

- [ ] 将本机 Resource 服务和 Skills 移入 `resource/`。
- [ ] 将 `resource` 加入 pnpm workspace。
- [ ] 根 `pnpm dev` 并行启动 Web、Remote、Resource。
- [ ] 增加 `dev:resource` 和统一 `check` 命令。
- [ ] 运行 Resource 测试并确认 7342 服务合同不变。

### Task 2: Web 同源 Skills 地址

**Files:**
- Create: `apps/web/src/skills/public-skill-url.ts`
- Create: `apps/web/src/skills/public-skill-url.test.ts`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/product/HomePage.tsx`
- Modify: `apps/web/src/product/HomePage.test.tsx`
- Modify: `apps/web/src/demo/model-home/ModelHomePage.tsx`
- Modify: `apps/web/src/demo/skills/skill-install-state.ts`
- Modify: `apps/web/src/demo/skills/skill-install-state.test.ts`

- [ ] 增加由当前页面源站生成 `/skills/{name}` 绝对地址的纯函数。
- [ ] Vite 将 `/skills/*` 代理到 `VITE_RESOURCE_DEV_TARGET`，默认 7342。
- [ ] HTML 与 PPTX 演示提示词统一使用仓库内 Resource Skills。
- [ ] 更新提示词与地址测试。

### Task 3: Remote 公开地址与内部下载地址

**Files:**
- Modify: `apps/remote/src/skills/skill-source-url.ts`
- Modify: `apps/remote/src/skills/skill-installer.ts`
- Modify: `apps/remote/src/index.ts`
- Modify: `apps/remote/src/skills/skill-cli.ts`
- Modify: `apps/remote/test/skills/skill-resource-bundle.test.ts`
- Modify: `.env.example`

- [ ] 保留 `SKILL_RESOURCE_ORIGINS` 对用户提示词公开源站的校验。
- [ ] 增加 `SKILL_RESOURCE_FETCH_BASE`，只替换受信 Skill URL 的源站并保留 `/skills/{name}` 路径。
- [ ] 源码开发默认内部下载基址为 `http://127.0.0.1:7342`。
- [ ] Docker 与云端配置为 `http://mk-web`。
- [ ] 测试公开 URL 被保留为安装来源、下载请求使用内部地址。

### Task 4: 文档统一

**Files:**
- Modify: `README.md`
- Modify: `docs/ONLINE_DEPLOYMENT_RESEARCH_TRD.md`
- Modify: 输出目录中的第一阶段、第二阶段、总架构和开发构建发布文档。

- [ ] 使用文本图说明 `resource/` 在开发态是服务、在生产态是构建输入。
- [ ] 统一两个自有镜像、三个运行容器。
- [ ] 统一公开源站与内部下载基址。
- [ ] 不添加版本变更记录、旧方案说明或 Mermaid。

### Task 5: 验证

- [ ] 运行 `pnpm install --lockfile-only` 更新工作区锁文件。
- [ ] 运行 Resource、Web、Remote 相关测试。
- [ ] 运行 `pnpm typecheck`。
- [ ] 运行 `pnpm build`。
- [ ] 启动 Resource 服务并验证 `/health`、`/skills` 和两个 Skill Bundle。
