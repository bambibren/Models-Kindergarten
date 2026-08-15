# Skill Tool Argument Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留 `ensure_agent_skills` 的模型 `source_urls/mode` 参数，并在参数校验失败时保留原始错误、追加由当前用户消息生成的正确参数提示。

**Architecture:** Tool Provider 从当前用户消息同时保留原始 URL 候选和规范化授权集合。模型仍传递完整参数；Provider 产生结构化 `validationError`，ToolRuntime 将原始 `error`、`argument_hint` 与针对该错误的 instruction 一并返回模型。网络或执行错误不附加 `suggested_arguments`。

**Tech Stack:** TypeScript、现有 ToolRuntime、动态 JSON Schema、Vitest

---

### Task 1: 结构化参数错误合同

**Files:**
- Modify: `apps/remote/src/tools/tool-registry.ts`
- Modify: `apps/remote/src/tools/tool-runtime.ts`
- Test: `apps/remote/test/runtime/tool-runtime.test.ts`

- [ ] 增加失败测试：结构化 validation error 的 `rawOutput` 和 `modelContent` 同时包含原始 `error` 与 `argument_hint`。
- [ ] 将 `PreparedToolCall.validationError` 从字符串扩展为 `{ message, rawOutput, instruction }`，同时保留普通字符串供其他 Tool 使用。
- [ ] 让 `errorOutcome` 使用错误专属 instruction；没有专属提示的其他 Tool 保持现有行为。
- [ ] 运行 ToolRuntime 定向测试。

### Task 2: Skill 参数候选与正确参数提示

**Files:**
- Modify: `apps/remote/src/skills/github-skill-source.ts`
- Modify: `apps/remote/src/skills/ensure-agent-skills-tool.ts`
- Test: `apps/remote/test/skills/skill-installation.test.ts`

- [ ] 增加失败测试：用户消息中的 `.git` 和 `/tree/...` 原始写法进入动态 Schema enum。
- [ ] 增加失败测试：模型改写 URL 后，结果保留 `SKILL_SOURCE_NOT_USER_PROVIDED`，并附带全量原始 `suggested_arguments`。
- [ ] 增加原始候选提取函数，规范化仅用于授权比较，不能覆盖模型可见的原始值。
- [ ] Provider 生成动态 Schema；模型继续传入 `source_urls/mode`。
- [ ] 参数错误追加 `argument_hint`；网络错误不附带参数建议，并明确参数已经通过校验、不要修改 URL。
- [ ] 运行 Skill 安装定向测试。

### Task 3: 回归验证

**Files:**
- Modify only if tests expose a defect in the same flow.

- [ ] 运行 Remote 全测试和类型检查。
- [ ] 运行全仓 `git diff --check`、测试、类型检查和构建。
- [ ] 重启服务后用参数错误的 Tool 调用冒烟验证，确认页面仍显示原始错误，模型上下文同时收到正确参数提示。

## Self-Review

- 模型仍是 Tool Call 参数提出者，Service 不隐藏注入 URL。
- `.git` 与 `/tree/...` 原始值不会在建议参数中被改写。
- 只有参数错误出现 `argument_hint`；下载、网络和执行错误不伪装成参数错误。
- 原始错误码、类别和消息永远保留。
