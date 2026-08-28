import type { DemoAgent, DemoSavedComparison, DemoTask } from "./types.js";

export const demoTask: DemoTask = {
  title: "React 首屏性能诊断",
  prompt: "请分析当前 React 项目首屏加载缓慢的问题，在不更换技术栈的前提下给出可执行的优化方案，并说明实施顺序与验证方式。",
  requirements: [
    { id: "diagnose", label: "先定位首屏性能瓶颈，而不是直接给通用建议", sources: ["上下文", "Agent A", "Agent B", "Agent C"] },
    { id: "keep-stack", label: "保持 React 与现有构建工具不变", sources: ["上下文", "Agent B", "Agent C"] },
    { id: "sequence", label: "给出可以逐步实施的优化顺序", sources: ["上下文", "Agent A", "Agent B", "Agent C"] },
    { id: "verify", label: "包含优化前后的验证方式", sources: ["Agent A", "Agent B", "Agent C"] },
    { id: "risk", label: "说明优化可能引入的风险", sources: ["Agent B", "Agent C"] },
    { id: "independent-rollback", label: "异常改动必须能够独立回退", sources: ["Agent B", "Agent C"] },
  ],
};

export const demoAgents: DemoAgent[] = [
  {
    id: "base",
    name: "Agent A",
    variant: "Base",
    model: "qwen3:8b",
    tone: "slate",
    runPolicy: "reuse_snapshot",
    stream: [
      { id: "a-context", type: "context", title: "历史原始上下文", detail: "系统提示 · 工具 · 最近 6 轮聊天", tokens: 892, raw: "{\n  \"snapshotId\": \"turn-demo-731\",\n  \"policy\": \"historical\",\n  \"messages\": 9\n}" },
      { id: "a-thought", type: "thought", title: "已思考", text: "需要先定位性能瓶颈，再按影响与风险安排优化顺序。", tokens: 135 },
      { id: "a-tool", type: "tool", name: "read_file · package.json", status: "completed", input: "{ \"path\": \"package.json\" }", output: "已读取依赖与构建脚本。", tokens: 58 },
      { id: "a-answer", type: "answer", text: "建议先使用浏览器 Performance 面板观察首屏加载过程，重点检查长任务、资源加载和组件渲染耗时。\n\n可以采用代码分割、图片压缩和组件懒加载。对于体积较大的依赖，通过动态 import 延迟加载；对于列表页面，可以减少首屏渲染的数据量。\n\n实施后对比优化前后的首屏时间，并观察页面是否出现功能异常。", tokens: 684 },
    ],
    answerSections: [
      { id: "a-diagnosis", label: "问题定位", summary: "先观察长任务、资源与渲染耗时", tone: "analysis", text: "建议先使用浏览器 Performance 面板观察首屏加载过程，重点检查长任务、资源加载和组件渲染耗时。" },
      { id: "a-action", label: "优化动作", summary: "代码分割、资源压缩与懒加载", tone: "action", text: "可以采用代码分割、图片压缩和组件懒加载。对于体积较大的依赖，通过动态 import 延迟加载；对于列表页面，可以减少首屏渲染的数据量。" },
      { id: "a-validation", label: "验证方式", summary: "对比首屏时间并检查功能", tone: "validation", text: "实施后对比优化前后的首屏时间，并观察页面是否出现功能异常。" },
    ],
    understandingPoints: [
      { id: "a-u1", text: "需要先观察并定位首屏性能瓶颈", requirementId: "diagnose" },
      { id: "a-u2", text: "优化动作需要分步骤实施", requirementId: "sequence" },
      { id: "a-u3", text: "实施后要重新对比首屏时间", requirementId: "verify" },
    ],
    plan: [
      { id: "a-1", title: "观察性能", detail: "使用 Performance 面板记录首屏。" },
      { id: "a-2", title: "执行优化", detail: "加入懒加载并压缩资源。" },
      { id: "a-3", title: "重新测试", detail: "比较首屏加载耗时。" },
    ],
    execution: { score: 78, duration: "18.4 s", modelRounds: 2, toolCalls: 1, outputTokens: 684 },
  },
  {
    id: "context",
    name: "Agent B",
    variant: "Context",
    model: "qwen3:8b",
    tone: "blue",
    runPolicy: "run",
    stream: [
      { id: "b-context", type: "context", title: "编辑版本 B", detail: "关闭 Skills · 聊天历史裁剪为 2 轮", tokens: 604, raw: "{\n  \"policy\": \"context-short\",\n  \"skills\": false,\n  \"historyTurns\": 2\n}" },
      { id: "b-thought", type: "thought", title: "已思考", text: "需要用可复现指标建立基线，并逐项隔离改动，避免同时重写所有组件。", tokens: 196 },
      { id: "b-tool-1", type: "tool", name: "read_file · vite.config.ts", status: "completed", input: "{ \"path\": \"vite.config.ts\" }", output: "发现首屏 bundle 未配置手动拆包。", tokens: 64 },
      { id: "b-tool-2", type: "tool", name: "read_file · src/routes.tsx", status: "completed", input: "{ \"path\": \"src/routes.tsx\" }", output: "当前三个非首屏路由均为同步导入。", tokens: 77 },
      { id: "b-answer", type: "answer", text: "我会先建立基线，再决定改动。记录 LCP、INP、首屏 JS 体积和主线程长任务，同时保存一次 Performance trace，避免只凭体感优化。\n\n根据项目结构，第一步检查入口 bundle 与同步依赖；第二步检查路由级和组件级代码分割；第三步检查首屏请求是否串行。优先处理阻塞链路，而不是同时重写所有组件。\n\n每个改动单独提交并复测同一组指标。若懒加载造成布局跳动或请求瀑布恶化，则回退该改动。", tokens: 1_126 },
    ],
    answerSections: [
      { id: "b-baseline", label: "基线诊断", summary: "先记录核心指标和 Performance Trace", tone: "analysis", text: "我会先建立基线，再决定改动。记录 LCP、INP、首屏 JS 体积和主线程长任务，同时保存一次 Performance trace，避免只凭体感优化。" },
      { id: "b-sequence", label: "实施顺序", summary: "沿入口依赖、代码分割、请求链逐项处理", tone: "action", text: "根据项目结构，第一步检查入口 bundle 与同步依赖；第二步检查路由级和组件级代码分割；第三步检查首屏请求是否串行。优先处理阻塞链路，而不是同时重写所有组件。" },
      { id: "b-risk", label: "验证与回退", summary: "独立提交复测，异常时回退对应改动", tone: "risk", text: "每个改动单独提交并复测同一组指标。若懒加载造成布局跳动或请求瀑布恶化，则回退该改动，保留已经验证有效的资源压缩与缓存调整。" },
    ],
    understandingPoints: [
      { id: "b-u1", text: "优化前必须建立可复现的性能基线", requirementId: "diagnose" },
      { id: "b-u2", text: "不能更换现有 React 技术栈", requirementId: "keep-stack" },
      { id: "b-u3", text: "需要按阻塞链路安排实施顺序", requirementId: "sequence" },
      { id: "b-u4", text: "每项改动都要复测同一组指标", requirementId: "verify" },
      { id: "b-u5", text: "需要识别懒加载与请求瀑布恶化风险", requirementId: "risk" },
      { id: "b-u6", text: "异常改动必须能够独立回退", requirementId: "independent-rollback" },
    ],
    plan: [
      { id: "b-1", title: "建立可复现基线", detail: "记录核心指标、Bundle 和一次 Trace。" },
      { id: "b-2", title: "定位阻塞链路", detail: "检查入口依赖、请求瀑布和长任务。" },
      { id: "b-3", title: "最小改动优化", detail: "按影响逐项处理代码分割和资源加载。" },
      { id: "b-4", title: "同条件复测", detail: "逐个提交比较，保留明确有效的改动。" },
    ],
    execution: { score: 91, duration: "24.7 s", modelRounds: 3, toolCalls: 4, outputTokens: 1_126 },
  },
  {
    id: "skill",
    name: "Agent C",
    variant: "Skill",
    model: "qwen3:8b",
    tone: "green",
    runPolicy: "run",
    stream: [
      { id: "c-context", type: "context", title: "编辑版本 C", detail: "启用性能诊断 Skill · 最近 6 轮聊天", tokens: 1_018, raw: "{\n  \"policy\": \"skill-assisted\",\n  \"skills\": [\"performance-diagnosis\"],\n  \"historyTurns\": 6\n}" },
      { id: "c-thought", type: "thought", title: "已思考", text: "按下载、解析执行、数据等待和渲染四段拆解；优先复用仓库已有诊断能力。", tokens: 248 },
      { id: "c-tool-1", type: "tool", name: "activate_skill · performance-diagnosis", status: "completed", input: "{ \"skill\": \"performance-diagnosis\" }", output: "已载入四阶段诊断流程与验证清单。", tokens: 91 },
      { id: "c-tool-2", type: "tool", name: "read_file · reports/lighthouse.json", status: "completed", input: "{ \"path\": \"reports/lighthouse.json\" }", output: "LCP 4.2s；主线程长任务 3 个；首屏 JS 612KB。", tokens: 88 },
      { id: "c-answer", type: "answer", text: "先把问题拆成下载、解析执行、数据等待和渲染四段。使用 Lighthouse 获取实验室基线，再用 Performance 与 Network 面板确认真实瓶颈。\n\n实施顺序建议为：移除首屏未使用依赖；将非关键路由和重型组件改为动态加载；合并或并行首屏数据请求；为图片声明尺寸并生成合适规格；最后再处理高频渲染。\n\n验证时固定设备与网络条件，至少记录三次中位数。每个改动保留独立提交；出现功能回归、CLS 上升或请求链增长时直接回退对应步骤。", tokens: 1_438 },
    ],
    answerSections: [
      { id: "c-diagnosis", label: "分段诊断", summary: "拆分下载、执行、数据与渲染阶段", tone: "analysis", text: "先把问题拆成下载、解析执行、数据等待和渲染四段。使用 Lighthouse 获取实验室基线，再用 Performance 与 Network 面板确认真实瓶颈；如果仓库已有 Bundle Analyzer，则直接复用，不新增另一套分析工具。" },
      { id: "c-action", label: "优化路线", summary: "从未使用依赖到请求与渲染逐步推进", tone: "action", text: "实施顺序建议为：移除首屏未使用依赖；将非关键路由和重型组件改为动态加载；合并或并行首屏数据请求；为图片声明尺寸并生成合适规格；最后再处理高频渲染。每一步只解决一个已确认瓶颈。" },
      { id: "c-validation", label: "验证标准", summary: "固定条件取中位数，并保留独立回退点", tone: "validation", text: "验证时固定设备与网络条件，至少记录三次中位数，对比 LCP、长任务、首屏传输体积和请求瀑布。" },
      { id: "c-risk", label: "风险控制", summary: "功能、CLS 或请求链恶化时立即回退", tone: "risk", text: "每个改动保留独立提交；出现功能回归、CLS 上升或请求链增长时可直接回退对应步骤。" },
    ],
    understandingPoints: [
      { id: "c-u1", text: "首屏问题需要按四个执行阶段拆解", requirementId: "diagnose" },
      { id: "c-u2", text: "优先复用仓库现有工具和技术栈", requirementId: "keep-stack" },
      { id: "c-u3", text: "每一步只解决一个已确认瓶颈", requirementId: "sequence" },
      { id: "c-u4", text: "固定条件并使用多次结果中位数验证", requirementId: "verify" },
      { id: "c-u5", text: "需要检查功能、CLS 与请求链风险", requirementId: "risk" },
      { id: "c-u6", text: "为每项改动保留独立回退点", requirementId: "independent-rollback" },
    ],
    plan: [
      { id: "c-1", title: "拆分首屏阶段", detail: "区分下载、执行、数据与渲染耗时。" },
      { id: "c-2", title: "复用现有诊断能力", detail: "读取 Lighthouse、Trace 与 Bundle 证据。" },
      { id: "c-3", title: "按阻塞程度排序", detail: "先依赖和请求，再处理高频渲染。" },
      { id: "c-4", title: "隔离实施", detail: "每项优化使用独立提交和同条件复测。" },
      { id: "c-5", title: "回归与回退", detail: "检查功能、CLS 和请求链变化。" },
    ],
    execution: { score: 95, duration: "31.2 s", modelRounds: 4, toolCalls: 6, outputTokens: 1_438 },
  },
];

export const savedComparisons: DemoSavedComparison[] = Array.from({ length: 23 }, /** 更新「savedComparisons」对应状态，并保持写入顺序、原子性与容量约束。 */
(_, index) => ({
  id: `cmp-demo-${String(23 - index).padStart(3, "0")}`,
  title: ["聊天历史裁剪", "工具说明开关", "Skills 索引差异", "系统提示改写"][index % 4] + ` · 对照 ${String(23 - index).padStart(2, "0")}`,
  createdAt: `08-${String(Math.max(1, 10 - Math.floor(index / 3))).padStart(2, "0")} ${String(19 - index % 8).padStart(2, "0")}:20`,
  variantCount: index % 3 === 0 ? 3 : 2,
}));
