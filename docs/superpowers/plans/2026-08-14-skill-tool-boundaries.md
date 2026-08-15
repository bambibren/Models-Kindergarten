# Skill 工具最小职责重构实施计划

> **执行要求：** 逐项完成测试、实现与验证；不引入 Agent 框架或新的工作流抽象。

**目标：** 把 Skill 工具调用参数、GitHub 来源解析、Skill 目录发现、通用 Git 操作、Skill 安装发布拆开，让模型只需传原始 URL，仓库结构和操作系统细节由调用代码处理。

**最小架构：** `EnsureAgentSkillsToolProvider` 只做 Tool Schema、参数错误提示和结果包装；`github-skill-source.ts` 只把用户原始 GitHub URL 解析为规范来源；`SkillDiscovery` 只实现“从指定范围开始，返回第一次出现 `SKILL.md` 深度的全部目录”；`GitRepository` 封装 clone、commit 解析、tree 读取、稀疏检出和超时进程清理；`SkillInstaller` 只做来源暂存、校验、原子发布和卸载。

**技术栈：** Node.js 22、TypeScript、Vitest、系统 Git。

---

## 任务 1：锁定职责边界

**文件：**

- 新增：`apps/remote/src/git/git-command-runner.ts`
- 新增：`apps/remote/src/git/git-repository.ts`
- 新增：`apps/remote/src/skills/skill-discovery.ts`
- 修改：`apps/remote/test/skills/skill-installation.test.ts`

1. 将测试导入改为新模块，先让测试因模块不存在而失败。
2. 增加 Windows 进程树终止策略测试：Windows 使用 `taskkill /PID <pid> /T /F`，macOS/Linux 使用独立进程组信号。
3. 保留现有“第一次命中深度”“Git tree 不 checkout 即可发现”“超时不会永久 pending”测试。

## 任务 2：抽出通用 Git 能力

**文件：**

- 新增：`apps/remote/src/git/git-command-runner.ts`
- 新增：`apps/remote/src/git/git-repository.ts`
- 删除：`apps/remote/src/skills/git-command-runner.ts`

1. `git-command-runner.ts` 只负责无 shell 参数执行、输出上限、硬超时和跨平台进程树结束。
2. `git-repository.ts` 提供具体而非框架化的仓库操作：

```ts
const repository = await GitRepository.clone(url, target);
const commit = await repository.resolveCommit(ref);
const paths = await repository.listTreePaths(commit, scope);
await repository.checkout(ref, subdirectory);
```

3. clone 只对连接中断重试一次；格式、权限、仓库不存在立即失败。
4. macOS 在未显式设置代理时读取系统 HTTPS 代理；Windows/macOS 都优先继承进程代理和 Git 自身配置。

## 任务 3：抽出 Skill 发现能力

**文件：**

- 新增：`apps/remote/src/skills/skill-discovery.ts`
- 修改：`apps/remote/src/skills/skill-installation-service.ts`

1. 定义独立端口：

```ts
export interface SkillDiscoveryPort {
  discoverGitHub(source: GitHubSkillSource): Promise<GitHubSkillSource[]>;
}
```

2. `SkillDiscovery` 使用 Git tree 元数据查找 `SKILL.md`，只返回第一次命中深度的所有 Skill；某个命中目录内部不继续把资源目录当子 Skill。
3. `SkillInstallationService` 分别依赖 discovery 和 installer，不再通过 installer 发现来源。

## 任务 4：收窄 SkillInstaller

**文件：**

- 修改：`apps/remote/src/skills/skill-installer.ts`
- 修改：`apps/remote/src/index.ts`

1. 删除 `discoverGitHub`、Git 命令常量和 clone 重试实现。
2. Git 来源通过 `GitRepository` 暂存；SkillInstaller 保留 HTTPS/ref/subdir 边界校验、Skill 内容校验、原子替换、锁文件更新和卸载。
3. 启动装配分别创建 `SkillDiscovery` 与 `SkillInstaller`。

## 任务 5：验证与范围审计

**文件：**

- 修改：`apps/remote/test/skills/skill-installation.test.ts`
- 可能修改：受类型检查指出的调用点

1. 运行 Skill 安装专项测试。
2. 搜索 Remote 中所有直接 `git` 子进程和 Skill 发现逻辑，确认只有通用 Git 模块执行 Git，只有 Skill discovery 模块决定 `SKILL.md` 查找规则。
3. 运行 Remote 全量测试、类型检查和构建。
4. 兼容范围仅承诺 Node.js 22 + 已安装 Git 的 macOS/Windows 主线；不实现 GitHub Enterprise、SSH、私有仓库凭据、Git LFS/submodule、特殊代理自动发现或包含 `/` 的 branch 名 tree URL。
