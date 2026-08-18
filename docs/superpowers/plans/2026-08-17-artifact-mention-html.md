# Artifact、Mention 与 HTML Bundle 实施计划

> 日期：2026-08-17
> 依据：`product/产物与HTML-PPT生成链路升级-202608171455/产物与HTML-PPT生成链路升级-trd.md` v0.4 及用户确认后的最新代码
> 原则：先识别现有实现；已完成且已验证的能力直接跳过，不重复改造。

## 已确认跳过

- 不修改 `FileReference` HTML 预览的 JavaScript 策略：当前 `HtmlPreviewFrame` 已使用 `sandbox="allow-scripts"`，Remote CSP 已允许脚本，且已有测试。
- 不重做 Agent 权限框架：现有 `allow | ask | deny`、`PermissionGate` 与 `ToolRegistry` 已支持 `write_file=allow`；`run_command` 保持 `always_ask`。
- 不开发 Composer Editor、`contenteditable` 或行内文本节点；只在现有 Composer 外壳中加入 Tag 式 Mention。
- 不实现 PPTX 生成、PPTX 预览或内置 PPT/HTML Skill；不内置 MCP 和默认业务 Agent。
- 不做旧 FileReference、旧对话或旧 Workspace 迁移。

## 阶段 1：Artifact 合同与存储

1. 在 `packages/contracts/src/artifacts.ts` 定义 Artifact、BlobRef、HTML Bundle Manifest、Mention、列表/预览响应和稳定 `artifact://` URI。
2. 扩展 Prompt/Message Meta，使 ACP Prompt、实时回放和 `load` 能携带结构化 Mention；身份只依赖 `artifactId`。
3. 在 `apps/remote/src/artifacts/` 实现：
   - owner-scoped 元数据仓库；
   - SHA-256 内容寻址 Blob Store；
   - 归档/恢复；
   - `operationId` 幂等发布；
   - 单文件与 HTML Bundle 发布。
4. 从当前 Session 的 `FileSandbox` 读取发布源；对路径、符号链接、单文件、Bundle 总量和临时空间执行明确限制。
5. 单元测试覆盖：去重、幂等、owner 隔离、跨 Session Workspace 拒绝、同 owner Blob 复用、归档可恢复和损坏 Blob 直接失败。

## 阶段 2：Artifact Tool 与 Runtime Mention

1. 新增经 `ToolRuntime` 注册的 `read_artifact`、`publish_artifact` 和 `publish_html_bundle` Tool，不从 AgentRunner 绕过工具链。
2. Tool 从 `TurnScope` 获得 owner/session/turn，发布源只允许当前 Session Workspace；Artifact 读取只允许当前 owner。
3. Agent 未绑定 Tool 时不暴露；绑定并配置 `allow` 时不请求 ACP permission。
4. Prompt 入口校验 Mention owner；原始用户文本写入 Session，Mention 写入消息元数据；模型输入加入只读 Artifact handle 与稳定平台语义。
5. `load`/`resume` 保持现有行为，只增加 Mention 元数据投影，不新增另一套协议或 Runtime 状态。
6. 测试覆盖：ACP Prompt Meta 边界、Session 持久化/回放、无权 Mention 拒绝、Runtime 上下文可见、Tool 权限与资源链接。

## 阶段 3：HTML Bundle 发布与隔离预览

1. `publish_html_bundle` 递归收集显式根目录，入口必须是根内相对 `.html` 文件；拒绝符号链接、路径穿越和超限 Bundle。
2. Manifest 中每个文件指向内容寻址 Blob；重复图片/字体不复制。
3. 新增 owner 校验的 Artifact API：列表、搜索、详情、下载、Bundle 资源、归档、恢复和预览描述。
4. Web 复用现有 `HtmlPreviewFrame` 运行 JavaScript；为 Bundle 注入受控 `<base>` 资源地址，不改现有 FileReference 的已验证 CSP/iframe 实现。
5. 外链、CDN 字体、外部图片和脚本首版不做自包含拦截。
6. 测试覆盖：入口、相对资源、多 MIME、资源 404、外链不误拦截、脚本仍可运行、无 `allow-same-origin`。

## 阶段 4：textarea + Mention Tag

1. Composer 继续使用受控 `textarea`；输入 `@` 时打开 Artifact 搜索浮层。
2. 选中项显示在同一 Composer 边框内、textarea 前的深色 Tag，支持类型图标、名称、短 ID 和删除。
3. 文本与 Mention 数组独立保存；发送失败保留原文本和 Tag，成功后一起清空。
4. `onSend`、ACP Client、乐观消息、历史消息均携带同一结构化 Mention；显示名不参与身份或授权。
5. “我的产物”提供列表、搜索、下载、预览、归档/恢复；聊天产物面板兼容既有 FileReference 与新 Artifact。
6. 测试覆盖：`@` 触发、搜索、选择/去重/删除、键盘操作、发送成功/失败、同名区分和回放 Tag。

## 阶段 5：容量与说明校准

1. 将 FileSandbox 文本读写默认上限调整为 5 MiB；Artifact 单文件 100 MiB；HTML Bundle 500 MiB；一次 Turn staging 1 GiB。
2. 更新内置 Tool 描述：写入是否询问由 Agent permission 决定，不再宣称固定询问。
3. 更新 TRD 状态与现状表，明确 JavaScript 预览已存在且未二次修改。

## 阶段 6：验证与交付

1. 运行受影响包的定向测试、全仓 typecheck、全仓测试和 build。
2. 用真实浏览器验证：Artifact 列表、Tag Mention、发送/回放、HTML Bundle 动效、相对资源、下载、归档/恢复和拒绝越权。
3. 检查 Git 差异，确保没有内置 Skill/MCP/业务 Agent，也没有修改用户已有且已验证的预览逻辑。
4. 汇总项目外 `/Users/bones/Documents/Codex/2026-08-18/Models-Kindergarten-产物链路调研/` 中的 MCP/PPTX 调研报告；若 PPTX 实测偏离方案，只链接项目外的独立子 TRD，不把调研代码、验证产物或 PPTX 实现混入 MK 主线。
