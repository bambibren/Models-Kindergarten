import type {
  DemoAgentStrategy,
  DemoArtifact,
  DemoExperimentRecord,
  DemoModelStudent,
  DemoMcpInstallation,
  DemoResourceRow,
  DemoSession,
  DemoStreamItem,
} from "./demo-types.js";
import { createDefaultModules } from "./context-lab/context-lab-state.js";

export const demoModelStudents: DemoModelStudent[] = [
  {
    id: "student-qwen",
    name: "千问 8B 小朋友",
    model: "qwen3:8b",
    provider: "Ollama · 本地",
    protocol: "ollama_native",
    baseUrl: "http://127.0.0.1:11434",
    capabilities: { streaming: "supported", toolCalls: "supported", reasoning: "supported", usage: "supported" },
    score: 53,
    state: "在读",
  },
  {
    id: "student-deepseek",
    name: "DeepSeek 推理生",
    model: "deepseek-r1:8b",
    provider: "Ollama · 本地",
    protocol: "ollama_native",
    baseUrl: "http://127.0.0.1:11434",
    capabilities: { streaming: "supported", toolCalls: "unverified", reasoning: "supported", usage: "supported" },
    score: 47,
    state: "旁听",
  },
  {
    id: "student-silicon",
    name: "硅基流动新生",
    model: "Qwen/Qwen3-8B",
    provider: "硅基流动 · API",
    protocol: "openai_chat_completions",
    baseUrl: "https://api.siliconflow.cn/v1",
    capabilities: { streaming: "supported", toolCalls: "supported", reasoning: "unverified", usage: "supported" },
    score: null,
    state: "待评测",
  },
];

const defaultAgentModules = createDefaultModules();
const conciseAgentModules = createDefaultModules().map((module) => {
  if (module.id === "history") return { ...module, historyTurns: 2, value: "运行时保留最近 2 轮对话" };
  if (module.id === "mcp") return { ...module, selectedItems: [], value: "", tokens: 0 };
  if (module.id === "memory") return { ...module, enabled: false };
  return module;
});
const sandboxAgentModules = createDefaultModules().map((module) => {
  if (module.id === "skills") return { ...module, selectedItems: ["sandbox-notes"], value: "sandbox-notes" };
  if (module.id === "mcp") return { ...module, selectedItems: ["mcp-huaben-map"], value: "mcp-huaben-map", tokens: 164 };
  if (module.id === "memory") return { ...module, enabled: true };
  return module;
});

export const demoAgentStrategies: DemoAgentStrategy[] = [
  { id: "agent-default", name: "默认 Agent", description: "标准系统提示、工具、MCP、Skills 与动态聊天历史策略", modules: defaultAgentModules, updatedAt: "今天 20:30", state: "active" },
  { id: "agent-concise", name: "短上下文 Agent", description: "只保留最近 2 轮聊天，适合快速问答", modules: conciseAgentModules, updatedAt: "昨天 18:12", state: "active" },
  { id: "agent-sandbox", name: "沙箱笔记 Agent", description: "启用 sandbox-notes 与长期记忆示例", modules: sandboxAgentModules, updatedAt: "08-08 14:40", state: "draft" },
];

export const demoSessions: DemoSession[] = [
  { id: "demo-session-context", title: "比较不同聊天历史裁剪策略", updatedAt: "20:42", preview: "保留最近 6 轮与最近 2 轮的差异" },
  { id: "demo-session-site", title: "制作一页模型课程介绍站", updatedAt: "18:16", preview: "生成了 landing.html 与 README.md" },
  { id: "demo-session-novel", title: "科幻短篇的世界观与人物小传", updatedAt: "15:08", preview: "完成三幕结构和人物关系" },
  { id: "demo-session-sandbox", title: "整理沙箱里的实验笔记", updatedAt: "周六", preview: "读取并汇总 notes 目录" },
  { id: "demo-session-skill", title: "测试 sandbox-notes Skill", updatedAt: "周五", preview: "激活 Skill 并生成索引" },
  { id: "demo-session-tools", title: "并行 Tool Call 顺序验证", updatedAt: "周四", preview: "验证多个工具的稳定消息顺序" },
];

export const demoArtifacts: DemoArtifact[] = [
  {
    id: "artifact-readme",
    name: "README.md",
    kind: "markdown",
    content: `# Model Kindergarten 课程页\n\n这个静态产物说明页面结构与验证方式。\n\n## 页面结构\n\n- 顶部介绍 ModelStudent\n- 中部展示三项课程能力\n- 底部提供进入实验的入口\n\n## 验证\n\n1. 检查 1280px 与 768px 布局。\n2. 确认所有按钮拥有键盘焦点。\n3. 确认页面不加载外部脚本。`,
  },
  {
    id: "artifact-html",
    name: "landing.html",
    kind: "html",
    content: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#30312e;background:#f7f7f4}body{margin:0;padding:56px}main{max-width:720px;margin:auto}small{color:#7b7d76;letter-spacing:.12em}h1{font-size:44px;line-height:1.08;letter-spacing:-.04em;margin:18px 0}p{color:#666862;line-height:1.75}.rule{height:1px;background:#deded8;margin:32px 0}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:32px}.item{padding:16px 0;border-top:1px solid #deded8}.item b{display:block;margin-bottom:6px}</style></head><body><main><small>MODEL KINDERGARTEN · STATIC ARTIFACT</small><h1>让模型在清晰的上下文里学习。</h1><p>这是一个完全静态的 HTML 产物示例。脚本、表单提交与外部导航都不会执行。</p><div class="rule"></div><div class="grid"><section><h2>本次课程</h2><p>观察系统提示、工具、Skills 与聊天历史如何共同形成一次模型输入。</p></section><section><div class="item"><b>Context</b><span>4 个模块</span></div><div class="item"><b>Model</b><span>qwen3:8b</span></div><div class="item"><b>Mode</b><span>Static preview</span></div></section></div></main></body></html>`,
  },
];

export const demoChatStream: DemoStreamItem[] = [
  {
    id: "user-turn-731",
    type: "user",
    text: "请先查看 React 项目的公开文档，再读取我在话本地图里保存的产品想法，给出整合建议。",
    inputTokens: 31,
  },
  {
    id: "context-turn-731",
    type: "context",
    turnId: "turn-demo-731",
    totalTokens: 1_046,
    experimentEntry: true,
    items: [
      { id: "ctx-system", title: "系统提示", detail: "本地编程与文件沙箱约束", tokens: 286, raw: "{\n  \"role\": \"system\",\n  \"content\": \"你是 Models Kindergarten 的本地 Agent…\"\n}" },
      { id: "ctx-tools", title: "工具说明", detail: "list_files · read_file · write_file", tokens: 318, raw: "[\n  { \"type\": \"function\", \"function\": { \"name\": \"read_file\" } },\n  { \"type\": \"function\", \"function\": { \"name\": \"write_file\" } }\n]" },
      { id: "ctx-mcp", title: "Agent MCP 能力", detail: "DeepWiki · 话本地图", tokens: 154, raw: "[\n  { \"serverId\": \"mcp-deepwiki\", \"tools\": [\"read_wiki_structure\", \"ask_question\"] },\n  { \"serverId\": \"mcp-huaben-map\", \"tools\": [\"search_map_notes\", \"read_map_note\"] }\n]" },
      { id: "ctx-skills", title: "Skills 索引", detail: "sandbox-notes · web-static", tokens: 126, raw: "[\n  { \"role\": \"user\", \"content\": \"<available_skills>…</available_skills>\" }\n]" },
      { id: "ctx-history", title: "聊天历史", detail: "最近 2 轮", tokens: 162, raw: "[\n  { \"role\": \"user\", \"content\": \"先梳理页面目标\" },\n  { \"role\": \"assistant\", \"content\": \"页面目标已经整理。\" }\n]" },
    ],
  },
  {
    id: "mcp-boundary-turn-731",
    type: "mcp_boundary",
    agentName: "默认 Agent",
    allowedMcps: [],
    excludedCount: 0,
  },
  {
    id: "thought-turn-731",
    type: "thought",
    title: "已思考",
    text: "先使用当前 Agent 已绑定的 DeepWiki 查询公开项目，再调用话本地图读取 Admin 的产品笔记。未绑定的 MCP 不会出现在本轮 Tool Registry 中。",
    tokens: 96,
  },
  {
    id: "tool-deepwiki",
    type: "tool",
    name: "read_wiki_structure · facebook/react",
    status: "completed",
    input: "{ \"repoName\": \"facebook/react\" }",
    output: "返回公开仓库 Wiki 目录：架构、渲染器、调度与贡献指南。",
    tokens: 84,
    source: "mcp",
    serverName: "DeepWiki",
    toolCallId: "call_mcp_deepwiki_01",
    requiredMcpId: "mcp-deepwiki",
  },
  {
    id: "tool-huaben-map",
    type: "tool",
    name: "search_map_notes · 产品想法",
    status: "completed",
    input: "{ \"query\": \"模型上下文实验 产品想法\", \"limit\": 3 }",
    output: "找到 3 条 Admin 笔记：Agent 策略对比、MCP 权限边界、上下文 Token 观察。",
    tokens: 66,
    source: "mcp",
    serverName: "话本地图",
    toolCallId: "call_mcp_huaben_01",
    requiredMcpId: "mcp-huaben-map",
  },
  {
    id: "assistant-turn-731",
    type: "assistant",
    markdown: "我只使用了当前 Agent 已配置的远程 MCP：**DeepWiki** 提供公开 React 架构资料，**话本地图** 返回 Admin 保存的产品想法。整合建议是把 MCP 安装、Agent 能力绑定和聊天执行证据分别展示，同时确保未绑定的 MCP 不进入模型 Tool Registry。",
    outputTokens: 78,
    projectionKey: "mcp-demo-summary",
  },
];

export const demoExperiments: DemoExperimentRecord[] = Array.from({ length: 23 }, (_, index) => {
  const number = 23 - index;
  const variants = ["聊天历史裁剪", "工具说明开关", "Skills 索引差异", "系统提示改写"];
  return {
    id: `cmp-demo-${String(number).padStart(3, "0")}`,
    title: `${variants[index % variants.length]} · 对照 ${String(number).padStart(2, "0")}`,
    prompt: index % 2 === 0 ? "分析当前 React 页面并给出验证步骤" : "为模型幼儿园生成一份课程说明",
    model: "qwen3:8b",
    versionCount: index % 3 === 0 ? 3 : 2,
    createdAt: `2026-08-${String(Math.max(1, 10 - Math.floor(index / 3))).padStart(2, "0")} ${String(19 - (index % 8)).padStart(2, "0")}:20`,
    status: "saved" as const,
  };
});

export const demoModels: DemoResourceRow[] = [
  { id: "model-qwen", name: "qwen3:8b", detail: "本地编程 ModelStudent", meta: "Ollama · 5.2 GB", state: "在读" },
  { id: "model-deepseek", name: "deepseek-r1:8b", detail: "推理课程候选模型", meta: "Ollama · Demo", state: "候补" },
  { id: "model-remote", name: "SiliconFlow Adapter", detail: "远程 Provider 适配占位", meta: "API · 未连接", state: "未入学" },
];

export const demoMcpInstallations: DemoMcpInstallation[] = [
  {
    id: "mcp-deepwiki",
    name: "DeepWiki",
    description: "查询公开 GitHub 仓库的 Wiki、目录和问答",
    url: "https://mcp.deepwiki.com/mcp",
    transport: "streamable_http",
    authKind: "none",
    state: "ready",
    capabilities: [
      { name: "read_wiki_structure", kind: "tool", description: "读取公开仓库 Wiki 目录", readOnly: true },
      { name: "read_wiki_contents", kind: "tool", description: "读取指定 Wiki 内容", readOnly: true },
      { name: "ask_question", kind: "tool", description: "基于公开仓库文档回答问题", readOnly: true },
    ],
    boundAgentIds: ["agent-default"],
    lastCheckedAt: "10 分钟前",
  },
  {
    id: "mcp-huaben-map",
    name: "话本地图",
    description: "读取 Admin 在话本地图中保存的节点与产品想法",
    url: "https://map.example.com/mcp",
    transport: "streamable_http",
    authKind: "bearer",
    credentialHint: "•••• 7K2A",
    state: "ready",
    capabilities: [
      { name: "search_map_notes", kind: "tool", description: "搜索当前账号地图笔记", readOnly: true },
      { name: "read_map_note", kind: "tool", description: "读取指定地图节点", readOnly: true },
      { name: "create_map_note", kind: "tool", description: "创建新的地图笔记" },
      { name: "update_map_note", kind: "tool", description: "更新已有地图笔记" },
    ],
    boundAgentIds: ["agent-default", "agent-sandbox"],
    lastCheckedAt: "刚刚",
  },
  {
    id: "mcp-microsoft-learn",
    name: "Microsoft Learn",
    description: "检索微软官方技术文档和代码示例",
    url: "https://learn.microsoft.com/api/mcp",
    transport: "streamable_http",
    authKind: "none",
    state: "disabled",
    capabilities: [
      { name: "microsoft_docs_search", kind: "tool", description: "搜索 Microsoft Learn", readOnly: true },
      { name: "microsoft_docs_fetch", kind: "tool", description: "获取完整文档", readOnly: true },
    ],
    boundAgentIds: [],
    lastCheckedAt: "昨天 18:20",
  },
];

export const demoMcps: DemoResourceRow[] = demoMcpInstallations.map((mcp) => ({
  id: mcp.id,
  name: mcp.name,
  detail: mcp.description,
  meta: `HTTP · ${mcp.capabilities.filter((item) => item.kind === "tool").length} tools`,
  state: mcp.state === "ready" ? "可用" : mcp.state === "disabled" ? "已停用" : "未连接",
}));

export const demoSkills: DemoResourceRow[] = [
  { id: "skill-notes", name: "sandbox-notes", detail: "在文件沙箱中整理学习笔记", meta: "Local · SKILL.md", state: "已安装" },
  { id: "skill-web", name: "web-static", detail: "生成无脚本静态页面", meta: "Local · SKILL.md", state: "已安装" },
  { id: "skill-review", name: "code-review", detail: "按证据检查改动范围", meta: "Local · SKILL.md", state: "已安装" },
  { id: "skill-context", name: "context-lab", detail: "上下文实验流程占位", meta: "Demo", state: "草稿" },
];
