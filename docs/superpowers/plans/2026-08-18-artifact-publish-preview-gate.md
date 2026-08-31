# Artifact 发布与预览门禁 Implementation Plan

> **For Codex:** 按任务顺序执行；先补失败测试，再做最小实现，最后跑定向测试与类型检查。

**Goal:** Workspace 文件写入不再产生任何可预览入口；用户要求生成文件时，Agent 必须先成功发布 Artifact，才能把文件作为完成结果交付给用户。

**Architecture:** 在 Runtime 稳定系统提示词中声明统一交付契约，在 `write_file`、`publish_artifact`、`publish_html_bundle` 的工具定义与工具结果中重复关键边界。Remote ACP 投影不再把写入副作用转换为 `mk-file://`，Web 只把 `artifact://` 视为可预览内部资源。

**Tech Stack:** TypeScript、ACP、React、Vitest

**Status:** 已完成；Remote 250 项测试、Web 113 项测试及两端类型检查通过。

---

### Task 1: 固化稳定提示词和工具语义

**Files:**
- Modify: `apps/remote/src/runtime/agent-runtime.ts`
- Modify: `apps/remote/src/tools/tool-registry.ts`
- Modify: `apps/remote/src/artifacts/artifact-tool-provider.ts`
- Test: `apps/remote/test/runtime.test.ts`
- Test: `apps/remote/test/artifacts/artifact-tool-provider.test.ts`
- Test: `apps/remote/test/artifacts/html-artifact-chain.test.ts`

**Steps:**
1. 先让测试断言稳定提示词包含“写入不是交付、成功发布后才能完成和预览”。
2. 让写入工具结果明确要求继续调用适用的发布工具，并移除 Workspace 位置暴露。
3. 让两个发布工具明确只有成功发布产生的 Artifact 才能预览、下载和交付。

### Task 2: 关闭写入副作用到文件预览的投影

**Files:**
- Modify: `apps/remote/src/acp/kindergarten-agent.ts`
- Modify: `apps/remote/test/tool-loop.test.ts`

**Steps:**
1. 把现有“写完立即生成 `mk-file://`”测试改为“不创建 FileReference、不发送预览链接”。
2. 删除工具完成和 Turn 收尾阶段的自动 FileReference 创建逻辑。
3. 保留文件副作用记录供 Runtime 上下文使用，但不将其当作发布结果。

### Task 3: Web 只允许已发布 Artifact 打开预览

**Files:**
- Modify: `apps/web/src/components/tools/ToolItem.tsx`
- Modify: `apps/web/src/components/tools/ToolItem.test.tsx`
- Modify: `apps/web/src/components/chat/ContentRenderer.tsx`
- Modify: `apps/web/src/components/chat/ContentRenderer.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Steps:**
1. 先补测试，证明历史 `mk-file://` 不再显示预览按钮或可点击内部链接。
2. 工具卡片和消息正文只响应 `artifact://`。
3. 移除会话页的 Workspace FileReference 预览事件与面板接线，只保留已发布 Artifact 面板。

### Task 4: 验证

**Files:**
- Test: `apps/remote/test/runtime.test.ts`
- Test: `apps/remote/test/tool-loop.test.ts`
- Test: `apps/remote/test/artifacts/*.test.ts`
- Test: `apps/web/src/components/**/*.test.tsx`

**Steps:**
1. 运行 Remote 和 Web 定向测试。
2. 运行 Remote/Web 类型检查。
3. 确认现有用户改动未被覆盖，并记录最终行为与剩余模型层风险。
