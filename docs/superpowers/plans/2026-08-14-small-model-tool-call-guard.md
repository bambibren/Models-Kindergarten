# Small Model Tool Call Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只对显式标记为小模型的 ModelStudent，在同一用户 Turn 内第三次提交参数和值完全相同的无效 Tool Call 时结束运行，同时强化 Skill 安装后必须加载指令的模型上下文。

**Architecture:** ModelStudent 显式声明 `sizeClass`，运行装配层据此选择是否注入独立的 `RepeatedInvalidToolCallGuard`。Guard 按 `tool name + canonical JSON arguments` 统计跨模型轮次的无效调用；同一模型轮的并行重复只计一次，字段顺序不影响签名。通用 Schema 错误输出继续由 ToolRuntime 生成，与是否启用 Guard 无关。

**Tech Stack:** TypeScript、Vitest、现有 AgentRunner/ToolRuntime/ContextAssembler。

---

### Task 1: 锁定重复无效调用状态机

**Files:**
- Create: `apps/remote/src/runtime/repeated-invalid-tool-call-guard.ts`
- Create: `apps/remote/test/runtime/repeated-invalid-tool-call-guard.test.ts`

- [x] **Step 1: 写失败测试**

覆盖以下输入：同工具不同参数分别计数；对象字段顺序不同视为同参；同一模型轮重复只计一次；第三个不同模型轮的同参无效调用返回终止事实；新实例从零开始。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/runtime/repeated-invalid-tool-call-guard.test.ts`

Expected: FAIL，模块尚不存在。

- [x] **Step 3: 实现独立 Guard**

实现接口：

```ts
export class RepeatedInvalidToolCallGuard {
  constructor(private readonly maxAttempts = 3) {}
  inspect(round: number, prepared: PreparedToolCall[], outcomes: ToolOutcome[]): RepeatedInvalidToolCallLimit | undefined;
}
```

签名使用 `call.name + canonicalJson(modelCall.arguments)`；每个 `round` 对同一签名至多加一。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/runtime/repeated-invalid-tool-call-guard.test.ts`

Expected: PASS。

### Task 2: 按 ModelStudent 大小装配可选终止节点

**Files:**
- Modify: `apps/remote/src/model/model-provider.ts`
- Modify: `apps/remote/src/index.ts`
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `.env.example`
- Modify: `apps/remote/test/runtime.test.ts`

- [x] **Step 1: 增加显式模型大小配置**

在 `ModelStudent` 增加 `sizeClass: "small" | "large"`。产品启动读取 `MODEL_SIZE_CLASS`，默认 `small`，非法值直接失败。

- [x] **Step 2: 改造 AgentRunner 装配**

`AgentRunner` 接收可选 `RepeatedInvalidToolCallGuard`；未注入时完全不判断参数失败次数。删除 Runner 内部按工具名计数的旧函数。

- [x] **Step 3: 覆盖小模型和大模型行为**

小模型第三个跨轮同参错误得到 `TOOL_ARGUMENT_RETRY_LIMIT`；不同参数不互相累计；大模型重复同参三次后仍继续到最终正文。

- [x] **Step 4: 运行 Runtime 测试**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/runtime.test.ts test/runtime/repeated-invalid-tool-call-guard.test.ts`

Expected: PASS。

### Task 3: 修正 Skill 生命周期提示

**Files:**
- Modify: `apps/remote/src/skills/skill-tool-provider.ts`
- Modify: `apps/remote/src/skills/ensure-agent-skills-tool.ts`
- Modify: `apps/remote/src/conversation/context-assembler.ts`
- Modify: `apps/remote/test/capabilities.test.ts`
- Modify: `apps/remote/test/skills/skill-installation.test.ts`

- [x] **Step 1: 锁定上下文语义测试**

断言上下文明确区分：安装/绑定只代表可用；`activate_skill` 实际读取完整 SKILL.md；安装成功后必须对任务需要的 Skill 逐个调用；参数只能是 `{ "name": available_skills 中的原始名称 }`。

- [x] **Step 2: 强化 Tool Schema 描述**

`activate_skill` 的名称保持协议兼容，但标题和说明统一写成“加载 Skill 完整执行指令”，明确安装成功不等于已经加载。

- [x] **Step 3: 强化安装结果的下一动作**

`ensure_agent_skills` 成功结果返回已安装 Skill 名称以及结构化 `required_next_action`，要求模型下一轮调用 `activate_skill`，而不是直接开始任务。

- [x] **Step 4: 运行 Skill 专项测试**

Run: `pnpm --filter @kindergarten/remote exec vitest run test/capabilities.test.ts test/skills/skill-installation.test.ts`

Expected: PASS。

### Task 4: 全量校验与文档同步

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/MCP_SKILLS.md`

- [x] **Step 1: 记录非行业标准阈值**

说明模型轮总上限是 MK 产品配置，不是行业标准；重复无效调用 Guard 是仅对小模型启用的可移除运行节点。

- [x] **Step 2: 运行类型、测试与构建校验**

Run: `pnpm typecheck && pnpm test && pnpm build`

Expected: 所有命令退出码 0。

- [x] **Step 3: 检查最终差异**

确认只修改本计划范围内文件，不覆盖工作区已有的其他未提交变更。
