# Remote MCP Demo Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a front-end-only Demo that shows an Admin adding a remote Streamable HTTP MCP, binding installed MCPs to an Agent, and seeing only those bound MCPs appear in the chat execution stream.

**Architecture:** Keep every change under `apps/web/src/demo` except for the written design specification. Remote MCP installations and saved Agent edits use `sessionStorage` mock persistence. The Demo derives visible MCP calls from the selected Agent's MCP bindings so an unbound server is never rendered as callable.

**Tech Stack:** React 19, TypeScript, Vite, plain CSS, Lucide React, Vitest.

---

### Task 1: Lock the Demo domain model

**Files:**
- Modify: `apps/web/src/demo/demo-types.ts`
- Modify: `apps/web/src/demo/demo-data.ts`
- Create: `apps/web/src/demo/mcp/mcp-demo-state.ts`
- Test: `apps/web/src/demo/mcp/mcp-demo-state.test.ts`

- [ ] **Step 1: Add failing tests for account-level installation persistence and Agent allowlisting**

```ts
expect(mergeMcpInstallations(saved, builtIns)[0]?.name).toBe("话本地图")
expect(boundMcpIds(agent)).toEqual(["mcp-deepwiki"])
expect(filterStreamForAgent(items, agent).every((item) => item.type !== "tool" || item.requiredMcpId === "mcp-deepwiki")).toBe(true)
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @kindergarten/web test -- mcp-demo-state.test.ts`

Expected: FAIL because the state helpers and richer MCP types do not exist.

- [ ] **Step 3: Add `DemoMcpInstallation`, capability and connection-state types**

The state must separate installed configuration, auth state and runtime health. All records are account-level Demo data; no Token value is stored in the front-end mock.

- [ ] **Step 4: Implement sessionStorage helpers and Agent binding selectors**

Implement `loadSavedMcps`, `saveMcp`, `removeMcp`, `mergeMcpInstallations`, `boundMcpIds` and `filterStreamForAgent`. Tool entries with a `requiredMcpId` must survive only when that ID is enabled in the Agent's MCP module.

- [ ] **Step 5: Re-run the focused test**

Expected: PASS.

### Task 2: Add the remote MCP add/detail Demo page

**Files:**
- Create: `apps/web/src/demo/mcp/McpEditorPage.tsx`
- Create: `apps/web/src/demo/mcp/mcp-editor.css`
- Modify: `apps/web/src/demo/DemoApp.tsx`

- [ ] **Step 1: Add `/demo/mcp` to the Demo router**

Use query modes rather than separate implementations:

```text
/demo/mcp?mode=create
/demo/mcp?mcpId=mcp-deepwiki
```

- [ ] **Step 2: Build the single-source remote form**

Fields: display name, HTTPS MCP URL, authentication (`none` or `bearer`), masked Token input for Bearer. The page must explicitly state that only Streamable HTTP is supported and that the credential belongs to Admin.

- [ ] **Step 3: Implement the validation-to-install interaction**

`测试连接` transitions `idle → testing → success`; success reveals mock-discovered Tools, Resources and Prompts. `确认安装` writes a mock installation without the Token and returns to `/demo/me?tab=mcps`.

- [ ] **Step 4: Implement detail operations**

`重新连接`, `更新 Token`, `停用/启用`, and `卸载` must all have visible state changes. Updating a Token tests before replacing the masked credential metadata. Uninstall removes the mock installation and returns to the list.

### Task 3: Upgrade “我的 MCPs” into the account management list

**Files:**
- Modify: `apps/web/src/demo/me/MePage.tsx`
- Modify: `apps/web/src/demo/me/me.css`

- [ ] **Step 1: Replace the generic resource panel for the MCP tab**

Add `+ 添加 MCP` linking to `/demo/mcp?mode=create`, render remote-only installation rows, and link each row to its detail view.

- [ ] **Step 2: Show operational metadata without exposing secrets**

Each row shows transport, auth kind, capability counts, bound Agent count, last check, and derived state (`可用`, `需认证`, `连接失败`, `已停用`).

- [ ] **Step 3: Verify narrow layouts**

At 320–540px, preserve name and state, collapse secondary capability metadata, and keep the add action one line.

### Task 4: Make Agent MCP bindings explicit

**Files:**
- Modify: `apps/web/src/demo/context-lab/AgentStrategyFields.tsx`
- Modify: `apps/web/src/demo/context-lab/context-lab-state.ts`
- Modify: `apps/web/src/demo/context-lab/context-lab-state.test.ts`
- Modify: `apps/web/src/demo/context-lab/context-lab.css`

- [ ] **Step 1: Render a dedicated MCP selector rather than a generic option grid**

The selector must list only Admin-installed MCPs, show auth/health/capabilities, disable unavailable installations, and link to `/demo/me?tab=mcps`.

- [ ] **Step 2: State the execution invariant in the UI**

Copy: `只有勾选的 MCP 能力会进入当前 Agent 的 Tool Registry；未配置的 MCP 不会暴露给模型。`

- [ ] **Step 3: Recalculate token estimates from selected MCP IDs**

Update the MCP estimate table to use stable installation IDs. Verify empty selection reports `未选择` and zero tokens.

### Task 5: Demonstrate Agent-governed MCP execution in chat

**Files:**
- Modify: `apps/web/src/demo/shared/DemoChatStream.tsx`
- Modify: `apps/web/src/demo/session/SessionDemoPage.tsx`
- Modify: `apps/web/src/demo/session/session-demo.css`
- Modify: `apps/web/src/demo/demo-data.ts`

- [ ] **Step 1: Extend Demo tool entries with MCP provenance**

Add `source`, `serverName`, `toolCallId`, and `requiredMcpId`. Render MCP identity and call ID beside the existing input/output disclosure.

- [ ] **Step 2: Add an Agent selector to the Demo session header**

Changing Agent recomputes bound MCP IDs and filters the displayed execution stream. The header displays the active Agent and the number of allowed MCP installations.

- [ ] **Step 3: Render the execution boundary before MCP activity**

Show which MCP schemas were exposed for the turn and explicitly state that unbound servers were excluded before the model call. Do not render a fake rejected Tool Call for an MCP that was never exposed.

- [ ] **Step 4: Add representative remote MCP calls**

Use DeepWiki and 话本地图 mock calls with stable Tool Call IDs, input/output disclosures and chronological ordering.

### Task 6: Write the implementation-ready design specification

**Files:**
- Create: `docs/MCP_REMOTE_DEMO_DESIGN.md`

- [ ] **Step 1: Document product semantics and page inventory**

Cover account ownership, AuthSession identity, remote-only installation, token persistence, Agent allowlisting, runtime capability assembly and chat projection.

- [ ] **Step 2: Document state machines and acceptance criteria**

Define install/auth/connection states, reconnect vs update-token behavior, Agent binding rules, uninstallation behavior, mock boundaries and future real API mapping.

### Task 7: Verify the front-end Demo

**Files:**
- Verify only; do not modify production paths.

- [ ] **Step 1: Run tests**

Run: `pnpm --filter @kindergarten/web test`

Expected: all web tests pass.

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @kindergarten/web typecheck`

Expected: zero TypeScript errors.

- [ ] **Step 3: Run build**

Run: `pnpm --filter @kindergarten/web build`

Expected: Vite production build succeeds.

- [ ] **Step 4: Browser walkthrough**

Verify `/demo/me?tab=mcps` → add remote MCP → test → install → detail → Agent binding → `/demo/session`. Confirm changing Agent changes visible MCP calls and the browser console remains clean.

