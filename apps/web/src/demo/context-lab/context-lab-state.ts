import type {
  ContextExperimentMode,
  ContextModuleId,
  DemoContextModule,
  DemoContextVersion,
} from "../demo-types.js";

const versionNames = { a: "版本 A", b: "版本 B", c: "版本 C" } as const;
type HistoryTokenMode = "dynamic" | "snapshot";

const selectedItemTokenEstimates: Partial<Record<ContextModuleId, Record<string, number>>> = {
  tools: { read_file: 112, write_file: 118, list_files: 88, ask_user: 74 },
  mcp: { "mcp-deepwiki": 128, "mcp-huaben-map": 164, "mcp-microsoft-learn": 118 },
  skills: { "sandbox-notes": 64, "web-static": 62, "code-review": 58, "context-lab": 54 },
};

export function selectedItemsTokenEstimate(moduleId: ContextModuleId, items: string[]): number | null {
  const estimates = selectedItemTokenEstimates[moduleId];
  if (items.some((item) => estimates?.[item] === undefined)) return null;
  return items.reduce((total, item) => total + (estimates?.[item] ?? 0), 0);
}

export function updateSelectedItems(module: DemoContextModule, selectedItems: string[]): DemoContextModule {
  return {
    ...module,
    selectedItems,
    value: selectedItems.join(", "),
    tokens: selectedItemsTokenEstimate(module.id, selectedItems),
  };
}

export function createDefaultModules(historyTokenMode: HistoryTokenMode = "dynamic"): DemoContextModule[] {
  return [
    {
      id: "system",
      title: "系统提示",
      detail: "定义 ModelStudent 的身份、边界与回答风格",
      enabled: true,
      tokens: 286,
      value: "你是 Model Kindergarten 的本地 Agent。先理解任务，再使用必要工具；不得访问文件沙箱之外的路径。",
    },
    {
      id: "tools",
      title: "工具说明",
      detail: "向模型声明当前可调用的函数及参数结构",
      enabled: true,
      tokens: 318,
      value: "ACP tool schema",
      selectedItems: ["read_file", "write_file", "list_files"],
    },
    {
      id: "mcp",
      title: "MCP 能力",
      detail: "从“我的 MCPs”选择当前 Agent 可使用的工具与资源",
      enabled: true,
      tokens: 292,
      value: "mcp-deepwiki, mcp-huaben-map",
      selectedItems: ["mcp-deepwiki", "mcp-huaben-map"],
    },
    {
      id: "skills",
      title: "Skills 索引",
      detail: "只提供索引，模型需要时再读取具体 SKILL.md",
      enabled: true,
      tokens: 126,
      value: "available_skills index",
      selectedItems: ["sandbox-notes", "web-static"],
    },
    {
      id: "memory",
      title: "长期记忆",
      detail: "来自 ModelStudent 的跨会话学习记录",
      enabled: false,
      tokens: 92,
      value: "用户偏好中文输出；展示证据与可验证产物。",
    },
    {
      id: "history",
      title: "聊天历史",
      detail: "按最近轮数裁剪后写入模型输入",
      enabled: true,
      tokens: historyTokenMode === "snapshot" ? 162 : null,
      value: historyTokenMode === "snapshot" ? "最近 6 轮对话" : "运行时保留最近 6 轮对话",
      historyTurns: 6,
    },
  ];
}

function makeVersion(id: DemoContextVersion["id"], options?: Partial<DemoContextVersion>, historyTokenMode: HistoryTokenMode = "dynamic"): DemoContextVersion {
  return {
    id,
    name: versionNames[id],
    locked: false,
    runPolicy: "run",
    modules: createDefaultModules(historyTokenMode),
    ...options,
  };
}

export function createFreshVersions(): DemoContextVersion[] {
  return [makeVersion("a"), makeVersion("b")];
}

export function createHistoryVersions(): DemoContextVersion[] {
  return [
    makeVersion("a", { name: "历史原始版本", locked: true, runPolicy: "reuse_snapshot" }, "snapshot"),
    makeVersion("b", { name: "编辑对照版本", locked: false, runPolicy: "run" }, "snapshot"),
  ];
}

export function addVersion(versions: DemoContextVersion[]): DemoContextVersion[] {
  if (versions.length >= 3 || versions.some((version) => version.id === "c")) return versions;
  const source = versions.find((version) => !version.locked) ?? versions[0];
  if (!source) return versions;
  return [...versions, { ...makeVersion("c"), modules: cloneModules(source.modules) }];
}

export function removeVersion(versions: DemoContextVersion[], id: DemoContextVersion["id"]): DemoContextVersion[] {
  const target = versions.find((version) => version.id === id);
  if (!target || target.locked || versions.length <= 2) return versions;
  return versions.filter((version) => version.id !== id);
}

export function updateModule(
  versions: DemoContextVersion[],
  versionId: DemoContextVersion["id"],
  moduleId: ContextModuleId,
  updater: (module: DemoContextModule) => DemoContextModule,
): DemoContextVersion[] {
  const target = versions.find((version) => version.id === versionId);
  if (!target || target.locked) return versions;
  return versions.map((version) => {
    if (version.id !== versionId) return version;
    return {
      ...version,
      modules: version.modules.map((module) => module.id === moduleId ? updater(module) : module),
    };
  });
}

export function estimatedTokens(version: DemoContextVersion): number {
  return version.modules.reduce((total, module) => total + (module.enabled ? module.tokens ?? 0 : 0), 0);
}

export function hasDynamicTokens(version: DemoContextVersion): boolean {
  return version.modules.some((module) => module.enabled && module.tokens === null);
}

export function versionTokenLabel(version: DemoContextVersion): string {
  const known = estimatedTokens(version);
  return hasDynamicTokens(version) ? `静态约 ${known} tokens + 动态项` : `约 ${known} tokens`;
}

export function moduleTokenLabel(module: DemoContextModule): string {
  if (!module.enabled) return "不带入";
  if (module.selectedItems && module.selectedItems.length === 0) return "未选择";
  return module.tokens === null ? "运行时计算" : `约 ${module.tokens} tokens`;
}

export function strategyFingerprint(version: DemoContextVersion): string {
  return JSON.stringify(version.modules.map((module) => ({
    id: module.id,
    enabled: module.enabled,
    value: module.value,
    selectedItems: [...(module.selectedItems ?? [])].sort(),
    historyTurns: module.historyTurns,
  })));
}

export function canRunExperiment(mode: ContextExperimentMode, prompt: string, versions: DemoContextVersion[]): boolean {
  if (prompt.trim().length === 0 || versions.length < 2 || versions.length > 3) return false;
  if (mode === "history_turn" && !versions.some((version) => version.runPolicy === "reuse_snapshot" && version.locked)) return false;
  return new Set(versions.map(strategyFingerprint)).size > 1;
}

export function modelPayload(configuration: Pick<DemoContextVersion, "modules">, prompt: string): string {
  const messages = configuration.modules.flatMap((module) => {
    if (!module.enabled) return [];
    if (module.id === "system") return [{ role: "system", content: module.value }];
    if (module.id === "history") return [{ role: "history", content: module.value, turns: module.historyTurns }];
    return [{ role: "context", name: module.id, content: module.value, selected: module.selectedItems }];
  });
  return JSON.stringify({ model: "qwen3:8b", messages: [...messages, { role: "user", content: prompt }] }, null, 2);
}

export function replaceVersionModules(
  versions: DemoContextVersion[],
  versionId: DemoContextVersion["id"],
  modules: DemoContextModule[],
): DemoContextVersion[] {
  const target = versions.find((version) => version.id === versionId);
  if (!target || target.locked) return versions;
  return versions.map((version) => version.id === versionId
    ? { ...version, modules: cloneModules(modules) }
    : version);
}

export function cloneModules(modules: DemoContextModule[]): DemoContextModule[] {
  const cloned = modules.map((module) => module.selectedItems
    ? updateSelectedItems({ ...module }, [...module.selectedItems])
    : { ...module });
  if (cloned.some((module) => module.id === "mcp")) return cloned;
  const mcpModule = createDefaultModules().find((module) => module.id === "mcp");
  const toolsIndex = cloned.findIndex((module) => module.id === "tools");
  if (!mcpModule) return cloned;
  cloned.splice(toolsIndex < 0 ? 0 : toolsIndex + 1, 0, mcpModule);
  return cloned;
}
