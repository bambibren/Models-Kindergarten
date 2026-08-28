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

/** 执行「selectedItemsTokenEstimate」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function selectedItemsTokenEstimate(moduleId: ContextModuleId, items: string[]): number | null {
  const estimates = selectedItemTokenEstimates[moduleId];
  if (items.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => estimates?.[item] === undefined)) return null;
  return items.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, item) => total + (estimates?.[item] ?? 0), 0);
}

/** 更新「updateSelectedItems」对应状态，并保持写入顺序、原子性与容量约束。 */
export function updateSelectedItems(module: DemoContextModule, selectedItems: string[]): DemoContextModule {
  return {
    ...module,
    selectedItems,
    value: selectedItems.join(", "),
    tokens: selectedItemsTokenEstimate(module.id, selectedItems),
  };
}

/** 根据已校验输入构建「createDefaultModules」结果，不额外持有调用方的大对象。 */
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

/** 根据已校验输入构建「makeVersion」结果，不额外持有调用方的大对象。 */
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

/** 根据已校验输入构建「createFreshVersions」结果，不额外持有调用方的大对象。 */
export function createFreshVersions(): DemoContextVersion[] {
  return [makeVersion("a"), makeVersion("b")];
}

/** 根据已校验输入构建「createHistoryVersions」结果，不额外持有调用方的大对象。 */
export function createHistoryVersions(): DemoContextVersion[] {
  return [
    makeVersion("a", { name: "历史原始版本", locked: true, runPolicy: "reuse_snapshot" }, "snapshot"),
    makeVersion("b", { name: "编辑对照版本", locked: false, runPolicy: "run" }, "snapshot"),
  ];
}

/** 执行「addVersion」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function addVersion(versions: DemoContextVersion[]): DemoContextVersion[] {
  if (versions.length >= 3 || versions.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(version) => version.id === "c")) return versions;
  const source = versions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(version) => !version.locked) ?? versions[0];
  if (!source) return versions;
  return [...versions, { ...makeVersion("c"), modules: cloneModules(source.modules) }];
}

/** 释放或删除「removeVersion」对应资源，重复调用仍保持安全。 */
export function removeVersion(versions: DemoContextVersion[], id: DemoContextVersion["id"]): DemoContextVersion[] {
  const target = versions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(version) => version.id === id);
  if (!target || target.locked || versions.length <= 2) return versions;
  return versions.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(version) => version.id !== id);
}

/** 更新「updateModule」对应状态，并保持写入顺序、原子性与容量约束。 */
export function updateModule(
  versions: DemoContextVersion[],
  versionId: DemoContextVersion["id"],
  moduleId: ContextModuleId,
  updater: (module: DemoContextModule) => DemoContextModule,
): DemoContextVersion[] {
  const target = versions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(version) => version.id === versionId);
  if (!target || target.locked) return versions;
  return versions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(version) => {
    if (version.id !== versionId) return version;
    return {
      ...version,
      modules: version.modules.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(module) => module.id === moduleId ? updater(module) : module),
    };
  });
}

/** 执行「estimatedTokens」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function estimatedTokens(version: DemoContextVersion): number {
  return version.modules.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, module) => total + (module.enabled ? module.tokens ?? 0 : 0), 0);
}

/** 判断「hasDynamicTokens」对应条件，只返回判定结果且不修改输入状态。 */
export function hasDynamicTokens(version: DemoContextVersion): boolean {
  return version.modules.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(module) => module.enabled && module.tokens === null);
}

/** 执行「versionTokenLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function versionTokenLabel(version: DemoContextVersion): string {
  const known = estimatedTokens(version);
  return hasDynamicTokens(version) ? `静态约 ${known} tokens + 动态项` : `约 ${known} tokens`;
}

/** 执行「moduleTokenLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function moduleTokenLabel(module: DemoContextModule): string {
  if (!module.enabled) return "不带入";
  if (module.selectedItems && module.selectedItems.length === 0) return "未选择";
  return module.tokens === null ? "运行时计算" : `约 ${module.tokens} tokens`;
}

/** 执行「strategyFingerprint」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function strategyFingerprint(version: DemoContextVersion): string {
  return JSON.stringify(version.modules.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(module) => ({
    id: module.id,
    enabled: module.enabled,
    value: module.value,
    selectedItems: [...(module.selectedItems ?? [])].sort(),
    historyTurns: module.historyTurns,
  })));
}

/** 判断「canRunExperiment」对应条件，只返回判定结果且不修改输入状态。 */
export function canRunExperiment(mode: ContextExperimentMode, prompt: string, versions: DemoContextVersion[]): boolean {
  if (prompt.trim().length === 0 || versions.length < 2 || versions.length > 3) return false;
  if (mode === "history_turn" && !versions.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(version) => version.runPolicy === "reuse_snapshot" && version.locked)) return false;
  return new Set(versions.map(strategyFingerprint)).size > 1;
}

/** 执行「modelPayload」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function modelPayload(configuration: Pick<DemoContextVersion, "modules">, prompt: string): string {
  const messages = configuration.modules.flatMap(/** 执行「messages」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(module) => {
    if (!module.enabled) return [];
    if (module.id === "system") return [{ role: "system", content: module.value }];
    if (module.id === "history") return [{ role: "history", content: module.value, turns: module.historyTurns }];
    return [{ role: "context", name: module.id, content: module.value, selected: module.selectedItems }];
  });
  return JSON.stringify({ model: "qwen3:8b", messages: [...messages, { role: "user", content: prompt }] }, null, 2);
}

/** 执行「replaceVersionModules」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function replaceVersionModules(
  versions: DemoContextVersion[],
  versionId: DemoContextVersion["id"],
  modules: DemoContextModule[],
): DemoContextVersion[] {
  const target = versions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(version) => version.id === versionId);
  if (!target || target.locked) return versions;
  return versions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(version) => version.id === versionId
    ? { ...version, modules: cloneModules(modules) }
    : version);
}

/** 执行「cloneModules」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function cloneModules(modules: DemoContextModule[]): DemoContextModule[] {
  const cloned = modules.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(module) => module.selectedItems
    ? updateSelectedItems({ ...module }, [...module.selectedItems])
    : { ...module });
  if (cloned.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(module) => module.id === "mcp")) return cloned;
  const mcpModule = createDefaultModules().find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(module) => module.id === "mcp");
  const toolsIndex = cloned.findIndex(/** 根据已校验输入构建「toolsIndex」结果，不额外持有调用方的大对象。 */
(module) => module.id === "tools");
  if (!mcpModule) return cloned;
  cloned.splice(toolsIndex < 0 ? 0 : toolsIndex + 1, 0, mcpModule);
  return cloned;
}
