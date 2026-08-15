# Skill Repository Source Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接受 GitHub 仓库根目录或仓库内目录作为 Skill 地址，按层安装第一次出现 `SKILL.md` 的全部目录，移除生产代码对 `/tree/{ref}/{directory}` 的唯一格式假设。

**Architecture:** 产品接受 `https://github.com/{owner}/{repo}` 和 `/tree/{ref}/{path}` 两种定位方式。从定位目录开始广度优先逐层检查；第一次发现 `SKILL.md` 时返回该层全部 Skill，并停止进入更深层。安装仍在隔离目录完成，持久化固定 commit 与目录。

**Tech Stack:** TypeScript、Node.js Git 子进程、Vitest、现有 SkillInstaller/SkillInstallationService。

---

### Task 1: 来源解析与用户授权

**Files:**
- Modify: `apps/remote/src/skills/github-skill-source.ts`
- Modify: `apps/remote/src/skills/ensure-agent-skills-tool.ts`
- Test: `apps/remote/test/skills/skill-installation.test.ts`

- [ ] 增加失败测试，断言 `https://github.com/greensock/gsap-skills` 和可选 `.git` 被识别为仓库来源；旧 `/tree/main/skills/gsap-core` 仅作为兼容输入解析。
- [ ] 将消息提取从写死 `/tree/` 的正则改为提取 GitHub HTTPS 仓库 URL 后交给统一解析器；比较规范化 URL，不再因尾斜杠或 `.git` 产生 `SKILL_SOURCE_NOT_USER_PROVIDED`。
- [ ] 运行 `pnpm --filter @kindergarten/remote test -- skill-installation.test.ts`，预期全部通过。

### Task 2: 首个 Skill 深度安装

**Files:**
- Modify: `apps/remote/src/skills/skill-installer.ts`
- Modify: `apps/remote/src/skills/skill-installation-service.ts`
- Test: `apps/remote/test/skills/skill-installation.test.ts`

- [ ] 增加测试，断言仓库根 URL 展开第一次发现 `SKILL.md` 深度的全部 Job items，并且不进入更深目录。
- [ ] 仓库根 URL 使用 Git `HEAD`，tree URL 使用明确 ref 与目录；广度优先逐层检查，首个命中深度后停止。逐项复用隔离安装、校验和 commit 固定逻辑，不执行仓库脚本。
- [ ] 所有深度都没有 `SKILL.md` 时返回清晰校验失败。
- [ ] 运行 Remote Skill 测试、Remote 全测试与 typecheck。

### Task 3: 页面提示、全仓审计与回归

**Files:**
- Modify: `apps/web/src/product/MePage.tsx`
- Modify: `apps/web/src/demo/skills/skill-install-state.ts`
- Modify: `apps/web/src/demo/skills/SkillInstallControl.tsx`
- Modify: `docs/DEMO_TO_PRODUCTION_CONTRACTS.md`

- [ ] 把生产与 Demo 输入提示改为 GitHub 仓库地址；Demo 校验不能继续声称必须 `/tree/`。
- [ ] 使用 `rg` 审计全仓 `tree/`、URL/path `startsWith/includes/match`、固定 host/port 与格式错误文案；逐项区分协议安全边界、UI 展示和 Demo 死代码。
- [ ] 修正发现的同类生产死假设，并记录保留项理由。
- [ ] 运行 `git diff --check && pnpm -r test && pnpm -r typecheck && pnpm -r build`。
- [ ] 通过真实 `greensock/gsap-skills` 根地址验证第一次命中深度安装 8 个 Skill，且不扫描各 Skill 的更深资源目录。确认页面热更新后现有历史会话仍可打开。

**Done when:** 仓库根地址不再误报“未由用户提供”或“必须包含 tree”；按层安装首次命中深度并停止深入；Skill 可安装、持久化并绑定 Agent；全仓测试、类型检查和构建通过。
