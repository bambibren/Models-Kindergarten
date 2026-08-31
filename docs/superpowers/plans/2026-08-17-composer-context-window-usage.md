# Composer Context Window Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在真实 Session 与 `/demo/session` 的 composer 发送区增加上下文窗口使用量指示器，展示如果用户此刻继续对话，当前完整会话上下文预计会占用绑定 ModelStudent 的多少窗口容量。

**Architecture:** 复用 JoyCode 的“小环形进度 + 悬浮详情”交互，但不复用其“累计页面字符数 ÷ 固定 128K”算法。每个 Turn 落盘后，Remote 使用与下一次 Prompt 相同的 ContextAssembler、历史裁剪、Agent/Skill/MCP 能力和 Provider 序列化路径执行一次无模型调用的 context preview，得到“下一次请求尚未加入新草稿前”的完整上下文估算，经 namespaced ACP 通知持久化和回放；Web reducer 只归约快照，Composer 只负责展示。

**Tech Stack:** TypeScript 7、ACP SDK 1.3、React 19、Zustand、Radix Popover、Vitest 4、CSS/SVG。

---

## 调研结论与范围

- JoyCode 在 `src/pages/RemoteAiDesign/components/ChatPanel.tsx` 中累计 user、assistant、tool、context summary 的字符数，以 `1 token ≈ 4 字符`、固定 `128K tokens` 算百分比；`ChatInputBase` 在发送按钮左侧显示 18px 环形进度，颜色阈值为 `<50% / 50%～79% / ≥80%`，悬浮层显示百分比和“清除记忆”。
- MK 已有更可靠的事实：Remote 掌握完整 Session 事实、真实 ContextAssembler、历史裁剪、Agent/Skill/MCP 能力、Provider 请求序列化，以及 ModelStudent 显式 `contextWindowTokens`。因此不能由 Web 把可见聊天字符机械累加，也不能把一个 Tool Turn 内多次模型请求的 `inputTokens` 相加。
- 本期指标定义为“当前完整会话的下一次请求基础占用”：包含系统指令、工具定义、当前生效的 Skill/MCP 上下文、经策略保留的历史消息、工具调用和工具结果、刚完成的 Assistant 回答；不包含尚未发送的 composer 草稿。
- 一个用户 Turn 可以包含多次模型请求。后续请求会重复携带此前上下文，因此 `10K + 12K` 不能解释为 `22K` 会话占用。Remote 在 Turn 结束后重新组装一次下一请求预览，直接计算当前完整上下文，避免求和和“只取最后一轮”两种偏差。
- 本期数值统一标为估算：Provider 的真实 input usage 只描述已经发生的某次请求，无法精确代表刚完成回答之后的当前会话；context preview 不调用模型或收费 token-count API。
- 新 Session 尚未发生模型请求时展示 `0%` 还是隐藏由产品口径决定；本计划默认隐藏，首次 Turn 完成后出现。ModelStudent 未配置窗口上限、预览失败或没有可用快照时隐藏圆环，不保留旧快照制造误导。
- 不增加“清除记忆”：MK 当前没有长期记忆产品对象，清空历史也不是普通 composer 操作。需要全新上下文时继续使用“新对话”。
- 真实 `/session`、`/sessions/:id` 使用受管快照；`/demo/session` 复用同一展示组件，但只传入明确标记为 Demo 的固定样例数据，不创建 ACP connection owner。

## File map

- `packages/contracts/src/index.ts`: 新增上下文窗口快照、通知类型和严格 parser。
- `packages/contracts/src/index.test.ts`: 合同合法/非法输入测试。
- `apps/remote/src/conversation/context-window-preview.ts`: 复用真实上下文装配与 Provider 序列化，生成下一次请求的完整会话占用估算，不调用模型。
- `apps/remote/src/runtime/agent-runtime.ts`: 暴露受控 context preview 入口并复用当前 ModelStudent/Agent 能力解析。
- `apps/remote/src/repository/session-types.ts`: 持久化 `context_window_usage` SessionEntry，并确保它不进入模型上下文。
- `apps/remote/src/conversation/context-assembler.ts`: 明确排除窗口快照事实。
- `apps/remote/src/acp/acp-output.ts`: 发送 namespaced ACP custom notification。
- `apps/remote/src/acp/kindergarten-agent.ts`: checkpoint、通知、load 回放，resume 保持零回放。
- `apps/remote/test/context-window-preview.test.ts`: 完整会话 preview、Tool 多请求、裁剪和无模型调用测试。
- `apps/remote/test/acp-session.test.ts`: 通知、持久化、load/resume 和 Session 隔离测试。
- `apps/web/src/acp/acp-client.ts`: 注册通知并交给 App handler。
- `apps/web/src/chat/chat-types.ts`: Web 已归约的不可见窗口快照 entry。
- `apps/web/src/chat/chat-reducer.ts`: 按 Session/Turn 归约，最新 Turn 覆盖旧快照。
- `apps/web/src/chat/context-window-usage.ts`: 选择最新快照并计算百分比、剩余量和视觉档位。
- `apps/web/src/components/composer/ContextWindowUsageIndicator.tsx`: 可访问的 SVG 圆环和详情浮层。
- `apps/web/src/components/composer/Composer.tsx`: 在发送/停止按钮左侧放置指示器。
- `apps/web/src/App.tsx`: 将当前 Session 的最新快照传给 Composer。
- `apps/web/src/styles.css`: 与 MK 暖灰界面一致的尺寸、浮层、阈值色和窄屏样式。
- `apps/web/src/demo/session/SessionDemoPage.tsx`: 向同一组件传入固定 Demo 快照。
- `apps/web/src/demo/session/session-demo.css`: 让 Demo composer 的控件顺序与真实 composer 一致。

### Task 1: 冻结指标语义与 ACP 合同

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/index.test.ts`

- [ ] **Step 1: 先写 parser 失败测试**

覆盖：缺少 `sessionId/afterTurnId`、`estimatedTokens < 0`、`windowTokens <= 0`、token 值非安全整数、非法 `basis` 均拒绝；旧 Session 没有该通知仍合法。

- [ ] **Step 2: 定义稳定合同**

```ts
export const CONTEXT_WINDOW_USAGE_METHOD =
  "model-kindergarten/session/context-window-usage" as const;

export type ContextWindowUsageState =
  | {
      schemaVersion: 1;
      status: "available";
      afterTurnId: string;
      estimatedTokens: number;
      windowTokens: number;
      basis: "next_prompt_base";
    }
  | {
      schemaVersion: 1;
      status: "unavailable";
      afterTurnId: string;
      reason: "unknown_window" | "preview_failed";
    };

export interface ContextWindowUsageNotification {
  sessionId: string;
  state: ContextWindowUsageState;
}
```

百分比不进入合同，避免持久化可派生值；Web 对 `available` 状态使用 `estimatedTokens / windowTokens` 统一计算。`windowTokens` 随事实冻结，不能在回放旧 Turn 时改用当前 Catalog 新值。`afterTurnId` 明确快照是在该 Turn 完成后计算，`basis` 明确不包含下一条尚未发送的草稿。`unavailable` 是显式清除信号，防止 Web 保留旧百分比。

- [ ] **Step 3: 运行合同测试**

Run: `pnpm --filter @kindergarten/contracts test`

Expected: 新 parser 用例和既有合同用例全部 PASS。

### Task 2: Remote 预演下一次请求的完整会话上下文

**Files:**
- Create: `apps/remote/src/conversation/context-window-preview.ts`
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/test/runtime.test.ts`

- [ ] **Step 1: 写完整会话失败测试**

构造两轮对话，断言 preview 同时包含系统指令、工具定义、Skill/MCP 上下文、经 history policy 保留的两个 user/assistant 回合、工具调用结果和最新 Assistant 回答；Thought、`token_usage`、`context_summary`、旧窗口快照不进入下一次模型上下文。

- [ ] **Step 2: 写 Tool 多请求与裁剪测试**

构造同一用户 Turn 内两次模型请求，分别报告 `10_000` 和 `12_000` input tokens；断言 preview 不读取二者的和，也不直接把 `12_000` 当当前值，而是在最终回答落盘后重新组装一次完整上下文。再把历史推过 message/history 上限，断言被裁剪来源不计入 `estimatedTokens`。

- [ ] **Step 3: 实现无模型调用的 preview**

```ts
export interface ContextWindowPreview {
  estimatedTokens: number;
  windowTokens: number;
  basis: "next_prompt_base";
}
```

`AgentRuntime.previewContextWindow()` 复用当前 Session 绑定的 ModelStudent、Agent、ToolRuntime 与 ContextAssembler，对已完成 Turn 的完整 `sessionEntries` 追加一个空用户消息信封，执行与真实下一次 Prompt 相同的历史和 message budget，再分别调用 Provider 的 `serializeContext()` 序列化 system、tools 和 messages。这里刻意不使用包含 model、采样参数等非上下文请求字段的 `serializeInput()`，避免把不占上下文窗口的控制参数算进分子。估算器不调用 `model.stream()`、网络 token-count API 或另一套上下文拼装器。

- [ ] **Step 4: 明确失败和未知容量语义**

未配置 `contextWindowTokens` 时返回 `undefined`。上下文源加载或序列化失败时返回结构化失败给 ACP 层，由 ACP 层发布 unavailable 快照以清除 Web 旧值，同时记录 Remote 错误；不能让派生指标失败篡改已经完成的 Prompt Turn，也不能静默沿用上一个百分比。

- [ ] **Step 5: 验证 Runtime**

Run: `pnpm --filter @kindergarten/remote test -- runtime.test.ts tool-loop.test.ts`

Expected: 完整会话、Tool 多请求不求和、历史裁剪、最终回答计入、无模型调用、未知窗口和 preview 失败七类用例均 PASS。

### Task 3: 持久化并通过唯一 ACP owner 投影

**Files:**
- Modify: `apps/remote/src/repository/session-types.ts`
- Modify: `apps/remote/src/conversation/context-assembler.ts`
- Modify: `apps/remote/src/acp/acp-output.ts`
- Modify: `apps/remote/src/acp/kindergarten-agent.ts`
- Modify: `apps/remote/test/acp-session.test.ts`
- Modify: `apps/remote/test/context-message-budget.test.ts`

- [ ] **Step 1: 先写生命周期失败测试**

断言 Prompt 完成后通知一次；Session entry 保存一次；`load` 原顺序回放；`resume` 默认零回放；带游标的 resume 只补断线增量；另一 Session/连接收不到该通知。

- [ ] **Step 2: 新增不可见 Session 事实**

```ts
export interface SessionContextWindowUsageEntry {
  type: "context_window_usage";
  turnId: string;
  state: ContextWindowUsageState;
  createdAt: string;
}
```

它与 `token_usage/context_summary` 同为观测事实，`ContextAssembler` 必须显式跳过，不能重新消耗上下文。

- [ ] **Step 3: 沿既有 TurnProjection 出口保存和通知**

在 `finalizeOpenRounds()` 之后、`finishTurnWithEntries()` 之前，用“旧 Session entries + 当前 user entry + 已完成的 streaming entries”生成 preview，并把 available/unavailable 状态与 Turn 终态原子落盘。成功、截断、取消或失败 Turn 只要产生了可持久化内容，都重新计算；preview 自身失败时落盘 unavailable 以清除旧值，但不把已经完成的 Prompt 改判失败。由 `AcpOutput` 发送 namespaced custom notification。不得新增 SSE、控制 API 轮询或第二套事件 envelope。

- [ ] **Step 4: 验证 ACP 不变量**

Run: `pnpm --filter @kindergarten/remote test -- acp-session.test.ts context-message-budget.test.ts`

Expected: 生命周期用例 PASS，窗口事实不进入后续 `ModelInput.messages`。

### Task 4: Web 归约最新 Session 快照

**Files:**
- Modify: `apps/web/src/acp/acp-client.ts`
- Modify: `apps/web/src/chat/chat-types.ts`
- Modify: `apps/web/src/chat/chat-reducer.ts`
- Create: `apps/web/src/chat/context-window-usage.ts`
- Create: `apps/web/src/chat/context-window-usage.test.ts`
- Modify: `apps/web/src/chat/chat-reducer.test.ts`

- [ ] **Step 1: 写 selector/reducer 失败测试**

覆盖：无快照返回 `null`；最新状态为 `unavailable` 时返回 `null`；按 entry 顺序选择最新 Turn；load 回放后恢复；切换 Session 清空；旧 Session 通知不串入当前 Session；`estimatedTokens > windowTokens` 时百分比保留真实值但圆环填充上限为 100%。

- [ ] **Step 2: 注册自定义通知**

`AcpWebClient` 使用合同 parser，把已解析通知交给 `App`；组件和 reducer 都不能接触 Raw ACP params。

- [ ] **Step 3: 建立不可见投影和纯 selector**

```ts
export interface ContextWindowUsageView {
  estimatedTokens: number;
  windowTokens: number;
  percent: number;
  ringPercent: number;
  remainingTokens: number;
  basis: "next_prompt_base";
  level: "normal" | "warning" | "critical";
}
```

阈值沿用 JoyCode：`<50 normal`、`50～79 warning`、`≥80 critical`。百分比按一位小数保存展示精度：小于 0.1% 显示 `<0.1%`，超过窗口显示 `>100%`；剩余量最小为 0。

- [ ] **Step 4: 运行 Web 数据层测试**

Run: `pnpm --filter @kindergarten/web test -- context-window-usage.test.ts chat-reducer.test.ts`

Expected: 全部 PASS。

### Task 5: 在真实 Composer 和 Demo 中复用同一指示器

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/src/components/composer/ContextWindowUsageIndicator.tsx`
- Create: `apps/web/src/components/composer/ContextWindowUsageIndicator.test.tsx`
- Modify: `apps/web/src/components/composer/Composer.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/demo/session/SessionDemoPage.tsx`
- Modify: `apps/web/src/demo/session/session-demo.css`

- [ ] **Step 1: 安装并使用 Radix Popover**

Run: `pnpm --filter @kindergarten/web add @radix-ui/react-popover`

Expected: 只更新 Web dependency 与 workspace lockfile。

- [ ] **Step 2: 写渲染与可访问性失败测试**

断言：无 available 快照不渲染；有快照时按钮 `aria-label` 包含百分比；浮层包含使用量、窗口上限、剩余量、估算口径和“不含未发送草稿”；键盘 Enter/Space 可打开、Escape 可关闭；running 时指示器仍可查看上一个已完成 Turn 的快照。

- [ ] **Step 3: 实现 18px SVG 圆环**

指示器放在发送/停止按钮左侧，尺寸与 JoyCode 一致，但色彩使用 MK token：常态暖灰、50% 后琥珀、80% 后克制红。圆环轨道始终可见，进度从 12 点方向开始，变化使用 180ms transition；`prefers-reduced-motion` 下取消动画。

- [ ] **Step 4: 实现悬浮/点击详情**

详情文案固定为：

```text
上下文窗口
15.0%
当前会话约 1,200 / 8,000 tokens
剩余约 6,800 tokens
按下一次请求的实际上下文结构估算
```

下方补一行弱提示“包含当前保留的完整会话上下文，不含输入框中尚未发送的内容；实际发送时会随新 Prompt 和历史裁剪变化”。不提供清除按钮。

- [ ] **Step 5: 接入真实 App 与 Demo**

`App` 从当前 chat projection 选择最新 available 快照并传给 `Composer`；若最新状态为 unavailable 则隐藏。`/demo/session` 传入固定 `38_400 / 128_000`、`next_prompt_base` 样例，浮层附带“UI Demo 数据”；Demo 继续不挂载真实 ACP client。

- [ ] **Step 6: 响应式与交互细节**

桌面浮层优先向上、靠发送按钮右对齐；产物面板压缩聊天区时不得溢出。窄屏保留圆环，浮层限制在 viewport 内。发送、停止、reasoning selector 的禁用逻辑不变，指示器不抢占 textarea Enter 发送。

- [ ] **Step 7: 运行组件测试和构建**

Run: `pnpm --filter @kindergarten/web test && pnpm --filter @kindergarten/web typecheck && pnpm --filter @kindergarten/web build`

Expected: 全部 PASS。

### Task 6: 端到端验收

**Files:**
- Verify only: running services and browser UI

- [ ] **Step 1: 验证未知容量模型**

打开未配置 `contextWindowTokens` 的 ModelStudent Session，确认 composer 不显示圆环，Header 也不伪造窗口上限。

- [ ] **Step 2: 验证完整会话占用**

用已配置窗口的模型连续发送两轮提示；完成后圆环出现，详情包含两个保留回合、系统/工具/Skill/MCP 上下文与最新回答，不包含 Thought、观测事实或输入框草稿。验证整个过程没有额外模型请求。

- [ ] **Step 3: 验证 Tool 多请求与裁剪路径**

发起一次产生 Tool Call 的 Prompt，确认工具调用与工具结果进入完整会话 preview，但同一 Turn 的多个 Provider input usage 不相加。增加历史直到触发裁剪，确认圆环按裁剪后的下一次请求基础上下文更新。

- [ ] **Step 4: 验证 Session 生命周期**

刷新页面后快照恢复；切换 Session 不串线；断线 resume 不重复插入；新建空 Session 不继承旧百分比。

- [ ] **Step 5: 验证视觉与可访问性**

检查普通、50%、80%、超过 100% 四档；鼠标悬浮、点击、Tab、Enter/Space、Escape；桌面、窄屏、打开产物分栏；浏览器 console 无错误。

- [ ] **Step 6: 运行完整相关验证**

Run: `pnpm --filter @kindergarten/contracts test && pnpm --filter @kindergarten/remote test && pnpm --filter @kindergarten/web test && pnpm --filter @kindergarten/remote typecheck && pnpm --filter @kindergarten/web typecheck && pnpm --filter @kindergarten/remote build && pnpm --filter @kindergarten/web build`

Expected: 全部 PASS。

## Self-review

- Spec coverage: JoyCode 的环形占用与浮层效果、整个会话上下文、未知容量、Tool 多请求、历史裁剪、load/resume、真实 App 与 Demo 均有对应任务。
- Boundary check: Browser 与 Remote 仍只走官方 ACP；页面仍只有一个 connection owner；Remote 不保存 Web 投影，Web 不保存 Runtime 状态；无 SSE、EventBus、第二事件 envelope、Memory 或 Workflow。
- Accuracy check: 展示的是完整会话下一请求基础上下文，不是历史请求 token 的累计成本；不使用固定 128K；最终回答在落盘后通过真实上下文重组自然进入 preview；百分比的分子、分母、裁剪和估算口径都可解释。
- Product check: 不复制 JoyCode 的“清除记忆”，因为 MK 当前没有对应领域能力；需要空上下文时使用新 Session。
- Dirty-worktree check: 实施时必须先重新读取 `git status`，保留所有既有已修改和未跟踪内容；当前已观察到 `apps/remote/src/server/control-router.ts`、`apps/remote/src/tools/sandbox.ts`、`packages/contracts/src/common.ts`、`packages/contracts/src/index.ts`、`packages/contracts/src/product-config.ts`、`apps/remote/src/artifacts/`、`packages/contracts/src/artifacts.ts`、产物验证目录和既有未跟踪计划等用户改动。尤其修改 `packages/contracts/src/index.ts` 前只做最小 patch，不能覆盖并行工作。
