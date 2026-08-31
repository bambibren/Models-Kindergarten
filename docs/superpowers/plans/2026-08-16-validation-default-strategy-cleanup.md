# Validation And Default Strategy Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地审计 B-01～B-06：只保留已确认的必要逻辑，把暂时保留的数值集中配置，并让资源超限返回真实原因。

**Architecture:** 在 `@kindergarten/contracts` 新增唯一的 `PRODUCT_CONFIG`，Remote 与合同解析共同读取这份配置。Skill 校验只保留目录/符号链接安全边界、文件总数和总大小；Prompt 正文保持原始首尾空白；Skill URL 和工具资源超限使用明确的错误码、分类与文案。

**Tech Stack:** TypeScript 7、pnpm workspace、Vitest 4。

---

### Task 1: 集中配置 B-01～B-06 的保留数值

**Files:**
- Create: `packages/contracts/src/product-config.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/management-contracts.test.ts`

- [x] **Step 1: 新增失败测试**

验证 `PRODUCT_CONFIG` 可从合同包导出，并验证带首尾空白的 `systemPrompt` 不被规范化。

- [x] **Step 2: 运行测试确认旧实现失败**

Run: `pnpm --filter @kindergarten/contracts test -- management-contracts.test.ts`

Expected: `PRODUCT_CONFIG` 不存在或 `systemPrompt` 仍被 trim，测试失败。

- [x] **Step 3: 新增唯一配置对象**

配置按 `skill`、`sessionLaunch`、`mcp`、`agent`、`tools` 分组；每个数字写中文注释说明用途和“当前工程默认值，可在此统一调整”。

- [x] **Step 4: 从合同入口导出配置**

在 `packages/contracts/src/index.ts` 增加：

```ts
export * from "./product-config.js";
```

- [x] **Step 5: 运行合同测试**

Run: `pnpm --filter @kindergarten/contracts test -- management-contracts.test.ts`

Expected: PASS。

### Task 2: 移除 B-01 未授权的 Skill 限制

**Files:**
- Modify: `apps/remote/src/skills/skill-validator.ts`
- Create: `apps/remote/test/skills/skill-validator.test.ts`

- [x] **Step 1: 新增失败测试**

测试 Skill 目录可包含隐藏文件、大于旧 256 KiB 的单文件、`scripts/` 外的可执行文件，且 frontmatter `name` 不必等于目录名；同时验证总文件数和总大小仍读取 `PRODUCT_CONFIG` 并拒绝超限。

- [x] **Step 2: 运行测试确认旧实现失败**

Run: `pnpm --filter @kindergarten/remote test -- test/skills/skill-validator.test.ts`

Expected: 旧限制导致合法样例失败。

- [x] **Step 3: 删除旧限制**

删除目录名一致、隐藏文件、单文件大小、可执行文件位置、Skill name 格式/长度、description 长度和资源路径字符数上限；保留非空字段、目录边界、符号链接、普通文件、总文件数和总大小校验。

- [x] **Step 4: 运行 Skill 校验测试**

Run: `pnpm --filter @kindergarten/remote test -- test/skills/skill-validator.test.ts`

Expected: PASS。

### Task 3: 配置 B-02～B-04 并修正 URL 上限错误

**Files:**
- Modify: `packages/contracts/src/common.ts`
- Modify: `apps/remote/src/skills/skill-installation-service.ts`
- Modify: `apps/remote/src/skills/ensure-agent-skills-tool.ts`
- Modify: `apps/remote/src/session/session-launch-service.ts`
- Modify: `apps/remote/src/mcp/mcp-management-service.ts`
- Modify: `apps/remote/test/skills/skill-installation.test.ts`
- Modify: `apps/remote/test/session/session-launch-service.test.ts`
- Modify: `apps/remote/test/mcp/mcp-management.test.ts`

- [x] **Step 1: 新增失败测试**

验证超过 Skill URL 上限时返回 `SKILL_SOURCE_URL_LIMIT_EXCEEDED` 和“最多 N 个、本次 M 个”的真实文案；验证 Session 草稿和 MCP 测试过期时间来自配置。

- [x] **Step 2: 运行三组测试确认失败**

Run: `pnpm --filter @kindergarten/remote test -- test/skills/skill-installation.test.ts test/session/session-launch-service.test.ts test/mcp/mcp-management.test.ts`

Expected: 旧代码仍返回通用格式错误或使用文件内常量，测试失败。

- [x] **Step 3: 实现配置读取与领域错误**

空 URL 数组继续作为缺少必要输入处理；只有超过上限时返回新的资源上限错误。不要新增分批提交、单目录或 UI 展示规则。

- [x] **Step 4: 运行三组测试**

Run: `pnpm --filter @kindergarten/remote test -- test/skills/skill-installation.test.ts test/session/session-launch-service.test.ts test/mcp/mcp-management.test.ts`

Expected: PASS。

### Task 4: 配置 B-05 并保留 Prompt 原文

**Files:**
- Modify: `packages/contracts/src/common.ts`
- Modify: `packages/contracts/src/agent-management.ts`
- Modify: `packages/contracts/src/management-contracts.test.ts`

- [x] **Step 1: 扩展字符串解析器**

为正文提供“使用原值返回，但用 trim 后结果判断是否为空”的选项；标识符和名称继续 trim。

- [x] **Step 2: 替换 Agent 合同中的固定上限**

名称、说明、system prompt、Tool ID、Installation ID、远端工具名、资源 URI 和最近 Turn 数全部读取 `PRODUCT_CONFIG.agent`。

- [x] **Step 3: 验证原文与上限**

Run: `pnpm --filter @kindergarten/contracts test -- management-contracts.test.ts`

Expected: 名称仍规范化，`systemPrompt` 首尾空白完整保留，合同测试 PASS。

### Task 5: 配置 B-06 并返回资源限制

**Files:**
- Modify: `apps/remote/src/tools/process-sandbox.ts`
- Modify: `apps/remote/src/tools/web-access.ts`
- Modify: `apps/remote/src/tools/tool-registry.ts`
- Modify: `apps/remote/test/runtime.test.ts`

- [x] **Step 1: 新增失败测试**

模拟公网响应声明超出配置大小，断言错误为 `web_response_too_large`、分类为 `resource_limit`，文案包含实际上限。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @kindergarten/remote test -- test/runtime.test.ts`

Expected: 旧实现抛普通 Error，测试失败。

- [x] **Step 3: 替换工具预算常量**

命令长度、默认/最大超时、输出字节数、网页查询长度、搜索结果数、响应字节数、模型文本长度、请求超时和重定向数全部读取 `PRODUCT_CONFIG.tools`。

- [x] **Step 4: 将网页大小超限改成结构化资源错误**

所有 `content-length` 和流式读取超限路径统一抛：

```ts
new ToolExecutionError(
  "web_response_too_large",
  "resource_limit",
  `网页响应超过 ${maxBytes} 字节资源上限`,
  false,
)
```

- [x] **Step 5: 运行 Runtime 测试**

Run: `pnpm --filter @kindergarten/remote test -- test/runtime.test.ts`

Expected: PASS。

### Task 6: 全量回归与审计

**Files:**
- Verify only

- [x] **Step 1: 类型检查**

Run: `pnpm typecheck`

Expected: 所有 workspace PASS。

- [x] **Step 2: 全量测试**

Run: `pnpm test`

Expected: 所有 workspace PASS。

- [x] **Step 3: 检查旧限制和散落数字**

Run: `rg -n "MAX_SINGLE_FILE_BYTES|Skill 不允许隐藏文件|只能位于 scripts|name 必须与目录名一致|一次只能提供 1-10|const TEST_TTL_MS|const MAX_FETCH_BYTES|const MAX_OUTPUT_BYTES" apps/remote/src packages/contracts/src`

Expected: 无命中。
