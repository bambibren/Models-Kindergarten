# Agent 与 ModelStudent 推理配置分离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 Agent 对模型推理强度和 ModelStudent 对 Agent system prompt 的反向控制，使推理配置只按 Session 覆盖与 ModelStudent 默认解析，并在归档后清空不兼容的历史会话。

**Architecture:** Agent 只保存上下文与能力策略；ModelStudent 保存模型接入、温度默认值和推理能力；Session 只允许覆盖推理强度；Turn 固化最终执行事实。Context Experiment 本轮只删除推理强度字段，不调整其他实验流程。

**Tech Stack:** TypeScript、React、ACP、Vitest、pnpm workspace、Remote JSON repositories

---

### Task 1: 收紧共享合同

**Files:**
- Modify: `packages/contracts/src/agent-management.ts`
- Modify: `packages/contracts/src/experiments.ts`
- Modify: `packages/contracts/src/reasoning.ts`
- Test: `packages/contracts/src/management-contracts.test.ts`
- Test: `packages/contracts/src/reasoning.test.ts`

- [x] **Step 1: 写失败测试**

断言 `parseAgentInput` 与 `parseExperimentInput` 的返回值不含 `defaultReasoningProfile`，并断言新的 reasoning source 只允许 `session_override | model_default`。

- [x] **Step 2: 运行合同测试并确认先失败**

Run: `pnpm --filter @kindergarten/contracts test`

- [x] **Step 3: 删除 Agent 与实验策略中的默认推理字段**

保留 `ReasoningProfile` 作为 UI 的 `auto` 选择，保留 `ConcreteReasoningProfile` 作为 Session override；从新 Turn 的 `ResolvedReasoning.source` 删除 `agent_default`。

- [x] **Step 4: 重新运行合同测试**

Run: `pnpm --filter @kindergarten/contracts test`
Expected: PASS

### Task 2: 调整 Remote 解析与模型输入

**Files:**
- Modify: `apps/remote/src/reasoning/reasoning-resolver.ts`
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/src/capability/runtime-capability-resolver.ts`
- Modify: `apps/remote/src/agent/agent-service.ts`
- Modify: `apps/remote/src/agent/agent-repository.ts`
- Modify: `apps/remote/src/repository/session-types.ts`
- Modify: `apps/remote/src/session/session-routes.ts`
- Test: `apps/remote/test/reasoning/*`
- Test: `apps/remote/test/runtime.test.ts`
- Test: `apps/remote/test/agent/*`

- [x] **Step 1: 写 Runtime 失败测试**

断言 Session 有覆盖时使用覆盖值；没有覆盖时直接使用 ModelStudent 默认值；Agent 输入不存在推理默认值；Agent system prompt 缺失时明确失败而不是读取 ModelStudent fallback。

- [x] **Step 2: 运行定向测试并确认先失败**

Run: `pnpm --filter @kindergarten/remote test -- reasoning runtime agent`

- [x] **Step 3: 实现最小解析链**

把优先级固定为 `sessionOverride ?? modelDefault`。从 Agent 持久化、实验 policy、Turn agent snapshot 和 Context preview Agent 字段中移除默认推理强度。Runtime 只使用解析出的 Agent system prompt；ModelStudent 继续拥有 temperature 默认值，Session 不增加 temperature 字段。

- [x] **Step 4: 运行 Remote 测试与类型检查**

Run: `pnpm --filter @kindergarten/remote typecheck && pnpm --filter @kindergarten/remote test`
Expected: PASS

### Task 3: 更新正式 Web 与 Demo 表达

**Files:**
- Modify: `apps/web/src/product/AgentEditorPage.tsx`
- Modify: `apps/web/src/product/ModelAdmissionPage.tsx`
- Modify: `apps/web/src/product/ContextLabPage.tsx`
- Modify: `apps/web/src/components/reasoning/ReasoningProfileSelect.tsx`
- Modify: `apps/web/src/reasoning/reasoning-config.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/demo/**`
- Test: `apps/web/src/reasoning/reasoning-config.test.ts`
- Test: `apps/web/src/demo/reasoning/demo-reasoning-state.test.ts`
- Test: `apps/web/src/demo/agent-editor/agent-storage.test.ts`

- [x] **Step 1: 写 UI 状态失败测试**

断言 Agent 表单与 Demo Agent 数据不再保存默认强度；ModelStudent 入园可从体检通过的档位中选择模型默认值；`auto` 的可见名称为 `跟随模型默认 · <模型默认档位>`；Context Experiment policy 不再携带推理字段。

- [x] **Step 2: 运行 Web 测试并确认先失败**

Run: `pnpm --filter @kindergarten/web test`

- [x] **Step 3: 删除控件并更新动态文案**

Agent 编辑器移除完整思考策略 section。模型入园在体检成功后允许从该模型真实支持的档位中选择默认值并随 ModelStudent 持久化。Session/Home/Composer 仍允许选择当前模型支持的具体档位；`auto` 读取当前 ModelStudent capability 的默认档位后渲染动态名称。

- [x] **Step 4: 运行 Web 验证**

Run: `pnpm --filter @kindergarten/web typecheck && pnpm --filter @kindergarten/web test && pnpm --filter @kindergarten/web build`
Expected: PASS

### Task 4: 保持可编辑 Agent 的 Session 语义

**Files:**
- Modify only if required: `apps/remote/src/capability/runtime-capability-resolver.ts`
- Modify only if required: `apps/remote/src/acp/kindergarten-agent.ts`
- Modify only if required: `apps/web/src/App.tsx`
- Test: `apps/remote/test/runtime/runtime-capability-resolver.test.ts`
- Test: `apps/remote/test/acp-session.test.ts`

- [x] **Step 1: 验证现有行为**

确认 Session 保存 Agent ID；Agent 修改后下一 Turn 读取新配置；已完成 Turn 保留旧 Agent snapshot。

- [x] **Step 2: 为删除 Agent 的场景补测试**

确认历史 Session 仍可 load/replay；新 prompt 明确返回“Agent 已删除，不能继续对话”，且不恢复或创建替代 Agent。

- [x] **Step 3: 仅在现状不满足时补最小错误投影**

不要阻止 Agent 删除，不引入 AgentRevision，也不修改 Context Experiment 的快照执行逻辑。

### Task 5: 归档并清空历史会话

**Files:**
- Archive: `apps/remote/.data` 中 Session/Turn 相关 JSON、会话文件与备份文件
- Preserve: Agent、ModelStudent、Skill、MCP 与 Secret 配置

- [x] **Step 1: 停止或确认 Remote 不在写 Session store**

记录 Remote PID 和监听端口；在复制期间不允许 Session repository 继续写入。

- [x] **Step 2: 创建带上海时区时间戳的只读归档**

归档目录必须在仓库外或 `.data/archives/` 的明确子目录中；写入清单、文件大小和 SHA-256，不输出 Secret 内容。

- [x] **Step 3: 清空 Session/Turn store**

清空聊天 Session、Turn 执行记录及其会话专属工作区、文件引用和评测记录；不要删除 Agent、ModelStudent、已安装 Skills、MCP 或 Secret。

- [x] **Step 4: 重启并验证空状态**

确认 Session 列表为空，Agent 与 ModelStudent 列表仍完整；通过自动化测试验证新 Session 与 Prompt 链路，不在清空后的真实数据中创建验收会话。

### Task 6: 全量回归

**Files:**
- Verify all modified files

- [x] **Step 1: 运行全仓检查**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS；仅允许既有 bundle size warning。

- [x] **Step 2: 检查工作树边界**

Run: `git diff --check`
Expected: PASS；不覆盖或提交用户已有改动。

- [x] **Step 3: 核对延期项**

确认本轮没有修改 Context Experiment 的 source-of-truth、History、preview serializer、评分、worksheet 或实验快照流程。
