# PPTX Runtime Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MK 增加可配置的 PPTX 构建能力，使 Agent 能在当前 Session Workspace 中执行 PptxGenJS 源码、得到经过基本结构校验的 `.pptx`，再复用通用 Artifact 链路发布和下载。

**Architecture:** 外部 PPTX Skill 继续由用户通过独立资源服务安装和绑定，MK 不读取 Skill 私有约定。Remote 新增 `PptxBuildService` 和 `PptxToolProvider`：前者通过固定进程入口在 FileSandbox 边界内执行源码并校验 OOXML，后者只负责 Tool Schema、Agent permission 和 ToolRuntime 结果。PPTX 不新增持久化模型、专用预览或附属文件，最终仍由现有普通文件 Artifact 能力承载。

**Tech Stack:** TypeScript、Node.js 22、PptxGenJS 4.0.1、ACP Tool Block、现有 ToolRuntime/FileSandbox/ArtifactService、Vitest。

---

### Task 1: PPTX 构建配置与 OOXML 检查

**Files:**
- Modify: `packages/contracts/src/product-config.ts`
- Modify: `packages/contracts/src/management-contracts.test.ts`
- Create: `apps/remote/src/pptx/pptx-inspector.ts`
- Create: `apps/remote/test/pptx/pptx-inspector.test.ts`

- [ ] **Step 1: 写出失败测试**

验证配置包含构建超时、源码上限和输出上限；验证检查器拒绝普通 ZIP、无幻灯片 PPTX 和损坏文件，并能从合法 OOXML 中得到页数。

```ts
expect(PRODUCT_CONFIG.pptx.buildTimeoutMs).toBe(120_000);
expect(() => inspectPptx(Buffer.from("not-a-zip"))).toThrow("PPTX_STRUCTURE_INVALID");
expect(inspectPptx(validPptx)).toMatchObject({ slides: 1 });
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @kindergarten/contracts test -- management-contracts.test.ts && pnpm --filter @kindergarten/remote test -- pptx-inspector.test.ts`

Expected: FAIL，因为配置和检查器尚不存在。

- [ ] **Step 3: 实现最小检查器**

只读取 ZIP central directory 文件名，不解压或生成任何旁路文件；必须存在 `[Content_Types].xml`、`_rels/.rels`、`ppt/presentation.xml` 和至少一张 `ppt/slides/slideN.xml`。

```ts
export interface PptxInspection { slides: number; entries: number }
export function inspectPptx(bytes: Buffer): PptxInspection;
```

- [ ] **Step 4: 运行定向测试**

Expected: Contracts 与 Inspector 测试 PASS。

### Task 2: 受控 PptxGenJS 进程执行

**Files:**
- Modify: `apps/remote/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/remote/src/pptx/pptx-build-service.ts`
- Create: `apps/remote/test/pptx/pptx-build-service.test.ts`

- [ ] **Step 1: 写出失败测试**

覆盖合法 `.cjs` 生成、越界路径、错误扩展名、非零退出、超时、取消、陈旧输出和损坏 OOXML。

```ts
const result = await service.build({ sourcePath: "deck/generate.cjs", outputPath: "deck/final.pptx" }, signal);
expect(result).toMatchObject({ outputPath: "deck/final.pptx", slides: 1 });
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @kindergarten/remote test -- pptx-build-service.test.ts`

Expected: FAIL，因为构建服务尚不存在。

- [ ] **Step 3: 加入固定依赖并实现服务**

添加 `pptxgenjs@4.0.1`。服务只接收当前 FileSandbox 内的 `.js/.cjs/.mjs` 和 `.pptx` 相对路径；固定使用当前 Node 进程，不接受任意命令、参数、环境变量或 URL。macOS 使用 `sandbox-exec` 拒绝网络并限制写入 Workspace；其他平台使用 Node permission model 限制文件和子进程权限。执行前后比较输出文件状态，成功后读取字节、校验大小、SHA-256 和 OOXML。

```ts
export class PptxBuildService {
  constructor(files: FileSandbox, runner?: PptxProcessRunner);
  build(input: { sourcePath: string; outputPath: string }, signal: AbortSignal): Promise<PptxBuildResult>;
}
```

- [ ] **Step 4: 运行定向测试**

Expected: 生成与错误分支测试 PASS；Workspace 中只出现源码、输入素材和指定 `.pptx`。

### Task 3: Runtime Tool 与 Agent Capability 接入

**Files:**
- Create: `apps/remote/src/pptx/pptx-tool-provider.ts`
- Create: `apps/remote/test/pptx/pptx-tool-provider.test.ts`
- Modify: `apps/remote/src/capability/runtime-capability-resolver.ts`
- Modify: `apps/remote/test/runtime/runtime-capability-resolver.test.ts`
- Modify: `apps/remote/src/index.ts`
- Modify: `apps/web/src/product/AgentEditorPage.tsx`

- [ ] **Step 1: 写出失败测试**

验证 `build_pptx` 只有在 Agent 启用时才进入模型 Tool Schema；permission=`allow` 不询问；结果不产生预览链接；失败不自动重试；Capability snapshot 包含稳定 Schema hash。

```ts
expect(provider.definitions.map((item) => item.function.name)).toEqual(["build_pptx"]);
expect(outcome.content).toEqual([]);
expect(outcome.effects?.fileRelativePaths).toEqual(["deck/final.pptx"]);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @kindergarten/remote test -- pptx-tool-provider.test.ts runtime-capability-resolver.test.ts`

Expected: FAIL，因为 Provider 尚未注册。

- [ ] **Step 3: 实现 Provider 与 Resolver 注册**

Tool 输入仅包含 `source_path`、`output_path`；Tool Result 返回路径、哈希、字节和页数。Provider 使用 Agent 已保存的 permission，`retry: "none"`，并经过现有 ToolRuntime。Agent capability options 增加该能力，但不创建或自动修改任何 PPT Agent；新建 Agent 表单默认不勾选 `build_pptx`。

- [ ] **Step 4: 运行定向测试**

Expected: Provider、Resolver、Agent 管理测试 PASS。

### Task 4: PPTX 与普通 Artifact 联调

**Files:**
- Modify: `apps/remote/test/artifacts/artifact-tool-provider.test.ts`
- Create: `apps/remote/test/pptx/pptx-artifact-chain.test.ts`

- [ ] **Step 1: 写出端到端失败测试**

在真实 Session Workspace 中生成一页 PPTX，随后调用现有 `publish_artifact(artifact_type="file")`，验证 MIME、下载字节、Artifact URI 和 SHA-256 一致；验证 Mention 后 `read_artifact` 物化的字节完全一致。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @kindergarten/remote test -- pptx-artifact-chain.test.ts`

Expected: 在 Provider 接入前 FAIL。

- [ ] **Step 3: 补齐最小联调逻辑**

复用现有 `.pptx` MIME、Artifact Blob Store、发布、下载和物化逻辑；不新增 PPTX Artifact 类型、Group、PDF、逐页图或检查报告。

- [ ] **Step 4: 运行联调测试**

Expected: PPTX build → publish → download → materialize 全链 PASS。

### Task 5: 实施文档与外部 Skill 服务

**Files:**
- Create: `product/产物与HTML-PPT生成链路升级-202608171455/PPTX生成链路开发实现与验收.md`
- Modify: `product/产物与HTML-PPT生成链路升级-202608171455/产物与HTML-PPT生成链路升级-trd.md`
- Read only: `/Users/bones/develop/mk-resource/skills`

- [ ] **Step 1: 记录实际开发逻辑**

文档说明调用链、文件职责、配置方式、权限行为、错误边界、部署依赖和不生成附属文件的正式边界。

- [ ] **Step 2: 写验收清单**

至少包含 Agent 配置、大聪明 + 外部 PPTX Skill、生成、发布、下载、PowerPoint 打开/编辑、Mention 图片复用、跨用户/跨 Session 拒绝、失败不自动重试和无附属文件等项目。

- [ ] **Step 3: 启动并验证外部资源服务**

Run: `npm test && npm start` in `/Users/bones/develop/mk-resource`

Expected: `/health`、`/skills`、`/skills/pptx` 返回 200；服务只读取外部目录，MK 仓库没有复制 Skill。

### Task 6: 全量回归

**Files:**
- Verify all modified files

- [ ] **Step 1: 运行完整检查**

Run: `pnpm typecheck && pnpm test && pnpm build`

Expected: 全部通过；仅允许已知非失败型打包提示。

- [ ] **Step 2: 扫描边界**

确认 MK 仓库没有内置 `skills/pptx`，PPTX 代码和提示词没有 PDF、逐页图、LibreOffice、Poppler、结构报告或 `run_command` 依赖。

- [ ] **Step 3: 汇总可验证结果**

列出提交、代码文件、测试数量、外部 Skill URL 和用户可直接执行的验收步骤。
