# Edit File 按行替换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `edit_file` Built-in Tool，让模型用多个“旧文本 → 新文本”片段完成事务式精确替换，而不再输出完整文件。

**Architecture:** `ToolRegistry` 负责公开中文 Tool Schema、严格解析 `edits` 数组并沿用写入权限；`FileSandbox` 负责路径、符号链接、UTF-8、文件大小和全量预校验，确认所有片段各匹配一次后才原子写回。一次调用中的任一编辑失败时，文件保持不变；成功结果继续进入现有 diff、文件引用和 Artifact 发布链。

**Tech Stack:** TypeScript、Node.js `fs/promises`、Vitest、ACP Tool Runtime

---

## 锁定的数据合同

实现和测试统一使用以下合同，不在执行阶段改名：

```ts
/** 描述一次按行替换；旧文本按字面值匹配，不解释正则表达式。 */
export interface SandboxTextEdit {
  oldText: string;
  newText: string;
}

/** 描述按行替换结果，供 Tool diff、文件引用和模型回执复用。 */
export interface SandboxEditResult extends SandboxWriteResult {
  replacements: number[];
  bytes: number;
}
```

模型看到的参数固定为：

```json
{
  "path": "index.html",
  "edits": [
    { "old_text": "唯一的旧文本片段", "new_text": "替换后的文本片段" },
    { "old_text": "另一段唯一旧文本", "new_text": "另一段新文本" }
  ]
}
```

沙箱公开方法固定为：

```ts
async editText(input: string, edits: SandboxTextEdit[]): Promise<SandboxEditResult>
```

匹配计数使用字面值扫描，禁止 `String.replace` 的正则和 `$&` 替换语义：

```ts
/** 统计非空字面值片段，供“必须唯一匹配”不变量复用。 */
function literalOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - search.length) {
    const index = content.indexOf(search, offset);
    if (index < 0) break;
    count += 1;
    offset = index + search.length;
  }
  return count;
}
```

关键事务测试固定包含以下断言：

```ts
const before = "头部\n旧甲\n中间保持不变\n旧乙\n尾部";
await sandbox.writeText("index.html", before);
await sandbox.editText("index.html", [
  { oldText: "旧甲", newText: "新甲" },
  { oldText: "旧乙", newText: "新乙" },
]);
expect((await sandbox.readText("index.html")).content)
  .toBe("头部\n新甲\n中间保持不变\n新乙\n尾部");
```

```ts
await sandbox.writeText("index.html", "唯一片段\n保持不变");
await expect(sandbox.editText("index.html", [
  { oldText: "唯一片段", newText: "已经改动" },
  { oldText: "不存在片段", newText: "不得写入" },
])).rejects.toThrow("旧文本必须恰好匹配一次");
expect((await sandbox.readText("index.html")).content).toBe("唯一片段\n保持不变");
```

### Task 1: 用失败测试锁定按行替换语义

**Files:**
- Modify: `apps/remote/test/tool-loop.test.ts`

- [ ] **Step 1: 新增 FileSandbox 成功场景测试**

创建包含相隔较远两段文本的文件，调用 `editText(path, edits)`，断言只替换两段目标文本、中间内容保持不变，并返回两次替换和修改后的完整文本。测试名称与辅助注释全部使用中文。

- [ ] **Step 2: 新增事务失败测试**

覆盖旧文本零匹配、同一旧文本多次匹配、空旧文本、目标文件不存在四种情况；每种情况都重新读取文件并断言内容没有变化。

- [ ] **Step 3: 运行定向测试并确认失败**

Run: `pnpm --filter @kindergarten/remote test -- tool-loop.test.ts`

Expected: FAIL，提示 `FileSandbox.editText` 尚不存在。

### Task 2: 在 FileSandbox 实现事务式精确替换

**Files:**
- Modify: `apps/remote/src/tools/sandbox.ts`

- [ ] **Step 1: 增加中文注释的数据合同**

新增 `SandboxTextEdit` 与 `SandboxEditResult`，字段固定为 `oldText`、`newText`、`replacements`，避免引入行号定位和正则替换。

- [ ] **Step 2: 实现全量预校验**

`editText` 必须复用现有相对路径、真实路径、符号链接、普通文件和大小检查；按数组顺序在内存副本中处理，每个 `oldText` 必须非空且在当前副本中恰好出现一次。全部校验完成前不得写盘。

- [ ] **Step 3: 原子写回并返回差异所需数据**

在目标文件同目录创建唯一临时文件，写入并校验大小后通过 `rename` 替换目标文件；失败时清理临时文件。返回 `oldText`、`newText`、最终字节数和各编辑替换次数。新增注释只解释事务、安全与顺序语义，全部使用中文。

- [ ] **Step 4: 运行定向测试并确认通过**

Run: `pnpm --filter @kindergarten/remote test -- tool-loop.test.ts`

Expected: PASS。

### Task 3: 把 edit_file 接入 Tool Registry 和权限链

**Files:**
- Modify: `apps/remote/src/tools/tool-registry.ts`
- Modify: `apps/remote/test/tool-loop.test.ts`

- [ ] **Step 1: 新增 Tool Schema 测试**

断言 `edit_file` 出现在 Definitions 中，中文说明明确“按行替换”“旧文本必须唯一匹配”“整次调用失败不修改文件”；参数为 `path` 和 `edits`，每项只允许 `old_text`、`new_text`，并拒绝额外字段。

- [ ] **Step 2: 新增 Registry 执行测试**

通过 `prepare` 和 `execute` 调用两个编辑片段，断言操作类型为 `edit`、默认权限与 `write_file` 一致、结果包含替换次数和 diff，并写出预期文件内容。

- [ ] **Step 3: 实现严格参数解析**

将 `edit_file` 加入 `ToolName`、Definition、名称白名单、`prepare` 与 `execute`。新增专用解析函数校验 `edits` 为非空数组、每项为普通对象、`old_text` 非空、`new_text` 为字符串；所有新增函数和边界均写中文注释。

- [ ] **Step 4: 沿用写入权限与产物交付提醒**

`edit_file` 使用与 `write_file` 相同的 Agent permission 绑定；成功后提醒模型文件仍只在 Workspace，用户要求交付文件时必须继续调用发布工具。

- [ ] **Step 5: 运行 Registry 定向测试**

Run: `pnpm --filter @kindergarten/remote test -- tool-loop.test.ts`

Expected: PASS。

### Task 4: 指导模型优先使用 edit_file

**Files:**
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/test/runtime.test.ts`
- Modify: `apps/remote/test/runtime/runtime-capability-resolver.test.ts`

- [ ] **Step 1: 新增 Runtime 指令测试**

断言模型系统提示明确说明：已有文本文件的小范围修改优先使用 `edit_file`；不得为少量字符修改重新调用 `write_file` 输出完整文件；新文件或整体重建仍使用 `write_file`。

- [ ] **Step 2: 更新中文运行时指令**

补充 `edit_file` 的选择规则和失败处理：零匹配或多匹配后先 `read_file` 获取当前内容，不得原参数重复调用。

- [ ] **Step 3: 更新能力解析断言**

将 `edit_file` 加入需要启用的 Built-in Tool 测试夹具，验证它受 Agent binding 过滤，并进入能力快照与 Schema 哈希。

- [ ] **Step 4: 运行相关测试**

Run: `pnpm --filter @kindergarten/remote test -- runtime.test.ts runtime-capability-resolver.test.ts`

Expected: PASS。

### Task 5: 完整验证与变更审计

**Files:**
- Verify: `apps/remote/src/tools/sandbox.ts`
- Verify: `apps/remote/src/tools/tool-registry.ts`
- Verify: `apps/remote/src/runtime/agent-runtime.ts`
- Verify: `apps/remote/test/tool-loop.test.ts`
- Verify: `apps/remote/test/runtime.test.ts`
- Verify: `apps/remote/test/runtime/runtime-capability-resolver.test.ts`

- [ ] **Step 1: 运行 Remote 类型检查**

Run: `pnpm --filter @kindergarten/remote typecheck`

Expected: PASS。

- [ ] **Step 2: 运行 Remote 完整测试**

Run: `pnpm --filter @kindergarten/remote test`

Expected: PASS；若仓库现有未提交改动导致无关失败，只记录可复现证据，不修改或回滚用户的其他工作。

- [ ] **Step 3: 审计中文注释和变更范围**

检查所有新增注释均为中文，且仅修改本计划列出的文件；通过 `git diff -- <scoped files>` 核对未覆盖用户已有改动。

- [ ] **Step 4: 提交仅限本功能的文件（仅在用户要求提交时执行）**

不得把当前工作区其他未提交修改带入提交；用户未要求 Git 提交时跳过此步骤。
