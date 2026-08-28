import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import { EvaluationTraceExporter } from "@kindergarten/evaluation-exporter";
import { KindergartenAgent } from "./acp/kindergarten-agent.js";
import { AgentRepository } from "./agent/agent-repository.js";
import { registerAgentRoutes } from "./agent/agent-routes.js";
import { AgentService } from "./agent/agent-service.js";
import { RuntimeCapabilityCatalog } from "./capability/runtime-capability-catalog.js";
import { RuntimeCapabilityResolver } from "./capability/runtime-capability-resolver.js";
import {
  ContextAssembler,
  McpResourceContextSource,
  SkillCatalogContextSource,
} from "./conversation/context-assembler.js";
import { McpClientManager } from "./mcp/mcp-client-manager.js";
import { McpConfigStore } from "./mcp/mcp-config-store.js";
import { McpToolProvider } from "./mcp/mcp-tool-provider.js";
import { SdkMcpConnector } from "./mcp/sdk-mcp-connector.js";
import { McpManagementRepository } from "./mcp/mcp-management-repository.js";
import { McpManagementService } from "./mcp/mcp-management-service.js";
import { registerMcpRoutes } from "./mcp/mcp-management-routes.js";
import { HostSecretStore } from "./mcp/secret-store.js";
import { OllamaProvider } from "./model/ollama-provider.js";
import { ResponsesApiProvider } from "./model/responses-api-provider.js";
import { ResponsesCapabilityProber } from "./model/responses-capability-probe.js";
import { ResponsesAdmissionAdapter } from "./model/responses-admission-adapter.js";
import { ChatCompletionsProvider } from "./model/chat-completions-provider.js";
import { SiliconFlowCapabilityProber } from "./model/siliconflow-capability-probe.js";
import { ModelAdmissionAdapterRegistry } from "./model/model-admission-adapter-registry.js";
import { ModelProviderPresetRegistry } from "./model/model-provider-preset-registry.js";
import { ModelAdmissionRepository } from "./model/model-admission-repository.js";
import type { ManagedModelStudentRecord, ProviderConnectionRecord } from "./model/model-admission-repository.js";
import { ModelAdmissionService } from "./model/model-admission-service.js";
import { registerModelAdmissionRoutes } from "./model/model-admission-routes.js";
import { RemoteModelUrlPolicy } from "./model/remote-model-url-policy.js";
import { ModelStudentCatalog } from "./model/model-student-catalog.js";
import type { ModelStudent } from "./model/model-provider.js";
import { SessionRepository } from "./repository/session-repository.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";
import { RemoteServer } from "./server/http-server.js";
import { ControlApi } from "./server/control-api.js";
import { SessionBindingService } from "./session/session-binding-service.js";
import { registerSessionRoutes } from "./session/session-routes.js";
import { SessionLaunchService } from "./session/session-launch-service.js";
import { SkillLockStore } from "./skills/skill-lock-store.js";
import { SkillRegistry } from "./skills/skill-registry.js";
import { SkillToolProvider } from "./skills/skill-tool-provider.js";
import { SkillDiscovery } from "./skills/skill-discovery.js";
import { SkillInstaller } from "./skills/skill-installer.js";
import { SkillInstallationRepository } from "./skills/skill-installation-repository.js";
import { SkillInstallationService } from "./skills/skill-installation-service.js";
import { configuredSkillResourceOrigins, SkillSourceUrlPolicy } from "./skills/skill-source-url.js";
import { registerSkillRoutes } from "./skills/skill-routes.js";
import { FileReferenceRepository } from "./files/file-reference-repository.js";
import { FileReferenceService } from "./files/file-reference-service.js";
import { registerFileRoutes } from "./files/file-routes.js";
import { FileSandbox } from "./tools/sandbox.js";
import { ExperimentRepository } from "./experiments/experiment-repository.js";
import { ExperimentService } from "./experiments/experiment-service.js";
import { EvaluationRecordClient } from "./experiments/evaluation-record-client.js";
import { registerExperimentRoutes } from "./experiments/experiment-routes.js";
import { ContextPreviewService } from "./experiments/context-preview-service.js";
import { AnnotationWorksheetGenerator } from "./experiments/annotation-worksheet-generator.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { ToolRuntime } from "./tools/tool-runtime.js";
import { createSmallModelRepeatedInvalidToolCallGuard } from "./runtime/repeated-invalid-tool-call-guard.js";
import { ArtifactRepository } from "./artifacts/artifact-repository.js";
import { ArtifactBlobStore } from "./artifacts/artifact-blob-store.js";
import { ArtifactService } from "./artifacts/artifact-service.js";
import { ARTIFACT_TOOL_IDS } from "./artifacts/artifact-tool-provider.js";
import { PPTX_TOOL_IDS } from "./pptx/pptx-tool-provider.js";
import { registerArtifactRoutes } from "./artifacts/artifact-routes.js";
import { OnlyOfficePreviewService } from "./artifacts/onlyoffice-preview.js";
import {
  DEFAULT_AGENT_SYSTEM_PROMPT,
  removeLegacyModelIdentity,
} from "./agent/default-agent-system-prompt.js";

const port = integerEnv("PORT", 7331);
const host = process.env.HOST ?? "127.0.0.1";
if (!isLoopbackHost(host)) {
  throw new Error("当前 D2P-1.2 只允许监听本机地址；远程访问认证尚不在本期范围内");
}
const workspaceRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const dataDir = resolve(process.env.DATA_DIR ?? ".data");
const sandboxDir = resolve(process.env.SANDBOX_DIR ?? `${dataDir}/sandbox`);
const userSkillsDir = resolve(process.env.USER_SKILLS_DIR ?? `${dataDir}/skills`);
const student = createStudent();
const model = new OllamaProvider(student);

const modelStudents = new ModelStudentCatalog(model, "unknown");
const modelSummary = await modelStudents.verify();
if (modelSummary.status !== "ready") console.warn(`ModelStudent 暂不可用：${modelSummary.statusMessage ?? "未知原因"}`);
const sandbox = new FileSandbox(sandboxDir);
await sandbox.initialize();
const artifacts = new ArtifactService(
  new ArtifactRepository(resolve(dataDir, "artifacts.json")),
  new ArtifactBlobStore(resolve(dataDir, "artifact-blobs")),
  resolve(dataDir, "workspaces"),
);
const secrets = new HostSecretStore();
const modelUrlPolicy = new RemoteModelUrlPolicy();
const modelAdmissionRepository = new ModelAdmissionRepository(
  resolve(dataDir, "model-student-tests.json"),
  resolve(dataDir, "model-admission-catalog.json"),
);
const mcp = new McpClientManager(
  new McpConfigStore(resolve(process.env.MCP_CONFIG_PATH ?? `${dataDir}/mcp/config.json`)),
  secrets,
  new SdkMcpConnector(secrets, sandbox.root),
);
const capabilityConfig = await mcp.initialize();
const skillLock = new SkillLockStore(
  resolve(process.env.SKILLS_LOCK_FILE ?? `${dataDir}/skills-lock.json`),
);
const skills = new SkillRegistry([
  {
    path: workspacePath(process.env.BUILTIN_SKILLS_DIR ?? "skills/builtin"),
    scope: "builtin",
    trust: "builtin",
    source: "builtin",
  },
  {
    path: workspacePath(process.env.PROJECT_SKILLS_DIR ?? ".agents/skills"),
    scope: "project",
    trust: "approved",
    source: "project",
  },
  {
    path: userSkillsDir,
    scope: "user",
    trust: "approved",
    source: "user",
  },
], skillLock);
await skills.initialize();
const skillInstallationRepository = new SkillInstallationRepository(
  resolve(dataDir, "skill-installations.json"),
  resolve(dataDir, "skill-install-jobs.json"),
);
const skillSourcePolicy = new SkillSourceUrlPolicy(
  configuredSkillResourceOrigins(process.env.SKILL_RESOURCE_ORIGINS),
);
const catalog = new RuntimeCapabilityCatalog([
  new ToolRegistry(sandbox),
  new McpToolProvider(mcp),
  new SkillToolProvider(skills, capabilityConfig.agentCapabilities.skills),
]);
const context = new ContextAssembler([
  new SkillCatalogContextSource(skills, capabilityConfig.agentCapabilities.skills),
  new McpResourceContextSource(mcp),
]);
const agentStoreFile = resolve(dataDir, "agents.json");
const agentStoreExisted = await fileExists(agentStoreFile);
const agentRepository = new AgentRepository(agentStoreFile);
let skillInstallations: SkillInstallationService;
const agentService = new AgentService(agentRepository, {
  builtinToolIds: /** 执行「builtinToolIds」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => [
    ...new ToolRegistry(sandbox).definitions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.function.name),
    ...ARTIFACT_TOOL_IDS,
    ...PPTX_TOOL_IDS,
  ],
  readySkillInstallationIds: /** 读取「readySkillInstallationIds」所需数据，并遵守作用域、分页与容量边界。 */
() => skillInstallations?.readyInstallationIdsSync() ?? [],
  mcpCapabilities: /** 执行「mcpCapabilities」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => mcp.capabilitySnapshots().map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(snapshot) => ({
    installationId: snapshot.serverId,
    tools: snapshot.tools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.name),
    resources: snapshot.resources.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.uri),
  })),
});
skillInstallations = new SkillInstallationService(
  skillInstallationRepository,
  new SkillDiscovery(userSkillsDir),
  new SkillInstaller(userSkillsDir, skillLock),
  skills,
  agentService,
  skillSourcePolicy,
);
await skillInstallations.importExisting();
const readySkillInstallations = await skillInstallations.list();
const mcpManagement = new McpManagementService(
  new McpManagementRepository(resolve(dataDir, "mcp-tests.json"), resolve(dataDir, "mcp-installations.json")),
  mcp,
  agentService,
);
await mcpManagement.importExisting();
let defaultAgent = (await agentService.list({ query: "系统默认 Agent", limit: 100 })).items
  .find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.name === "系统默认 Agent");
if (!defaultAgent && !agentStoreExisted) {
  defaultAgent = await agentService.create({
    name: "系统默认 Agent",
    description: "从 D2P-1 启用时的真实 Runtime 配置导入",
    systemPrompt: process.env.AGENT_SYSTEM_PROMPT ?? DEFAULT_AGENT_SYSTEM_PROMPT,
    builtinTools: [
      ...new ToolRegistry(sandbox).definitions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.function.name),
      ...ARTIFACT_TOOL_IDS,
    ].map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(toolId) => ({
      toolId,
      enabled: true,
      permission: "allow",
    })),
    skillInstallationIds: capabilityConfig.agentCapabilities.skills.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(name) => {
      const installation = readySkillInstallations.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.state === "ready" && item.skillName === name);
      if (!installation) throw new Error(`默认 Agent 引用了未安装的 Skill: ${name}`);
      return installation.skillInstallationId;
    }),
    mcps: [],
    historyPolicy: { mode: "recent_turns", maxTurns: 12 },
    memoryPolicy: { mode: "off" },
  });
}
if (defaultAgent) {
  const systemPrompt = removeLegacyModelIdentity(defaultAgent.systemPrompt);
  if (systemPrompt !== defaultAgent.systemPrompt) {
    defaultAgent = await agentService.update(defaultAgent.agentId, {
      name: defaultAgent.name,
      ...(defaultAgent.description ? { description: defaultAgent.description } : {}),
      systemPrompt,
      builtinTools: defaultAgent.builtinTools,
      skillInstallationIds: defaultAgent.skills
        .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.enabled)
        .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.skillInstallationId),
      mcps: defaultAgent.mcps,
      historyPolicy: defaultAgent.historyPolicy,
      memoryPolicy: defaultAgent.memoryPolicy,
    });
  }
}
if (defaultAgent) agentService.protect(defaultAgent.agentId);
const sessions = new SessionRepository(dataDir, {
  ownerId: "local-admin",
  modelStudentId: student.id,
  agentId: defaultAgent?.agentId ?? "unavailable-agent",
});
await sessions.persistMigrations();
const recoveredTurns = await sessions.recoverInterruptedTurns();
if (recoveredTurns > 0) console.warn(`已将 ${recoveredTurns} 个重启前未结束的 Turn 标记为 interrupted`);
const modelAdmissionAdapters = new ModelAdmissionAdapterRegistry([
  new ResponsesAdmissionAdapter(
    new ResponsesCapabilityProber({ endpointResolver: /** 执行「endpointResolver」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(url) => modelUrlPolicy.resolve(url) }),
    /** 执行「modelAdmissionAdapters」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(storedStudent, connection) => createResponsesProvider(storedStudent, connection, secrets, modelUrlPolicy),
  ),
  {
    protocol: "openai_chat_completions",
    adapterRevision: "siliconflow-chat-completions-v1",
    probeVersion: 1,
    probe: /** 执行「probe」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(candidate) => new SiliconFlowCapabilityProber({
      endpointResolver: /** 执行「endpointResolver」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(url) => modelUrlPolicy.resolve(url),
    }).probe(candidate),
    createProvider: /** 根据已校验输入构建「createProvider」结果，不额外持有调用方的大对象。 */
(storedStudent, connection) =>
      createSiliconFlowProvider(storedStudent, connection, secrets, modelUrlPolicy),
  },
]);
const modelAdmission = new ModelAdmissionService(
  modelAdmissionRepository,
  secrets,
  modelAdmissionAdapters,
  new ModelProviderPresetRegistry(modelAdmissionAdapters),
  modelStudents,
  modelUrlPolicy,
  {
    modelInUse: /** 执行「modelInUse」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(modelStudentId) => sessions.usesModelStudent(modelStudentId),
  },
);
const restoredModels = await modelAdmission.restoreInstalled();
for (const restored of restoredModels) {
  if (restored.status !== "ready") {
    console.warn(`ModelStudent ${restored.displayName} 暂不可用：${restored.statusMessage ?? "未知原因"}`);
  }
}
const evaluationServiceUrl = process.env.EVALUATION_SERVICE_URL ?? "http://127.0.0.1:7441";
const evaluation = new EvaluationTraceExporter(evaluationServiceUrl);
const resolver = new RuntimeCapabilityResolver(
  agentService,
  modelStudents,
  skills,
  mcp,
  resolve(dataDir, "workspaces"),
  skillInstallations,
  artifacts,
);
const contextPreviews = new ContextPreviewService(resolver);
const experimentService = new ExperimentService(
  new ExperimentRepository(resolve(dataDir, "experiments.json"), resolve(dataDir, "experiment-scorecards.json")),
  agentService,
  sessions,
  modelStudents,
  new EvaluationRecordClient(evaluationServiceUrl),
  evaluation,
  new AnnotationWorksheetGenerator(modelStudents),
  contextPreviews,
);
resolver.setExperimentSnapshotResolver(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(experimentId, testId) => experimentService.snapshot(experimentId, testId));
const bindings = new SessionBindingService({
  workspaceCwd: "/workspace",
  agentExists: /** 执行「agentExists」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async (id) => Boolean(await agentRepository.get(id)),
  modelStudentReady: /** 执行「modelStudentReady」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id) => modelStudents.isReady(id),
  experimentBinding: /** 执行「experimentBinding」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(experimentId, variantId) => experimentService.binding(experimentId, variantId),
});
const runtime = new AgentRuntime(
  model,
  new ToolRuntime(catalog),
  context,
  evaluation,
  resolver,
  createSmallModelRepeatedInvalidToolCallGuard,
);
const control = new ControlApi({
  allowedOrigins: (process.env.CONTROL_ALLOWED_ORIGINS ?? "http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:5175")
    .split(",").map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.trim()).filter(Boolean),
});
registerAgentRoutes(control.router, agentService);
registerSessionRoutes(control.router, sessions, new SessionLaunchService(resolve(dataDir, "session-launches.json"), agentService, modelStudents));
registerSkillRoutes(control.router, skillInstallations);
registerMcpRoutes(control.router, mcpManagement);
registerModelAdmissionRoutes(control.router, modelAdmission);
registerExperimentRoutes(control.router, experimentService, contextPreviews);
const fileReferences = new FileReferenceService(
  new FileReferenceRepository(resolve(dataDir, "file-references.json")),
  resolve(dataDir, "workspaces"),
  resolve(dataDir, "file-blobs"),
);
registerFileRoutes(control.router, fileReferences);
registerArtifactRoutes(control.router, artifacts, new OnlyOfficePreviewService());
const agent = new KindergartenAgent(sessions, runtime, bindings, experimentService, modelStudents, artifacts).createApp();
const server = new RemoteServer(agent, {
  studentId: student.id,
  studentName: student.name,
  provider: student.provider.kind,
  model: student.provider.model,
}, control);

await server.listen(host, port);
console.log(`Kindergarten Remote: ws://${host}:${port}/acp`);

/** 判断「isLoopbackHost」对应条件，只返回判定结果且不修改输入状态。 */
function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}
console.log(`ModelStudent: ${student.name} (${student.provider.model})`);
console.log(`Sandbox: ${sandbox.root}`);
console.log(`Skills: ${capabilityConfig.agentCapabilities.skills.join(", ") || "无"}`);
for (const state of mcp.serverStates()) {
  console.log(`MCP ${state.serverId}: ${state.status}${state.protocolEra ? ` (${state.protocolEra})` : ""}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => {
    void Promise.all([server.close(), evaluation.flush(), mcp.close()]).finally(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => process.exit(0));
  });
}

/** 根据已校验输入构建「createStudent」结果，不额外持有调用方的大对象。 */
function createStudent(): ModelStudent {
  const provider = process.env.MODEL_PROVIDER ?? "ollama";
  if (provider !== "ollama") {
    throw new Error(
      `V1.6 只实现 ollama Provider；${provider} 仅保留在 ModelProvider 适配接口中`,
    );
  }
  const contextWindowTokens = optionalPositiveIntegerEnv("MODEL_CONTEXT_WINDOW_TOKENS");
  return {
    id: process.env.MODEL_STUDENT_ID ?? "local-coder-student",
    name: process.env.MODEL_STUDENT_NAME ?? "本地编程小模型",
    sizeClass: modelSizeClassEnv("MODEL_SIZE_CLASS", "small"),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    provider: {
      kind: "ollama",
      baseUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
      model: process.env.OLLAMA_MODEL ?? "qwen3:8b",
    },
    generationDefaults: {
      temperature: numberEnv("MODEL_TEMPERATURE", 0.4),
      reasoningProfile: "balanced",
    },
  };
}

/** 根据已校验输入构建「createResponsesProvider」结果，不额外持有调用方的大对象。 */
function createResponsesProvider(
  storedStudent: ManagedModelStudentRecord,
  connection: ProviderConnectionRecord,
  secretStore: HostSecretStore,
  urlPolicy: RemoteModelUrlPolicy,
): ResponsesApiProvider {
  return new ResponsesApiProvider({
    id: storedStudent.modelStudentId,
    name: storedStudent.displayName,
    sizeClass: storedStudent.sizeClass,
    ...(storedStudent.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: storedStudent.contextWindowTokens }),
    provider: {
      kind: "openai-compatible",
      baseUrl: connection.baseUrl,
      model: storedStudent.model,
    },
    generationDefaults: { reasoningProfile: storedStudent.generationDefaults.reasoningProfile },
  }, {
    readBearerToken: /** 读取「readBearerToken」所需数据，并遵守作用域、分页与容量边界。 */
() => secretStore.read(connection.credentialRef),
    reasoning: {
      capability: storedStudent.snapshot.reasoning.capability,
      efforts: Object.fromEntries(Object.entries(storedStudent.snapshot.reasoning.nativeByProfile)
        .flatMap(/** 执行「efforts」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
([profile, native]) => typeof native?.effort === "string" ? [[profile, native.effort]] : [])),
    },
    endpointResolver: /** 执行「endpointResolver」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(url) => urlPolicy.resolve(url),
  });
}

/** 根据已校验输入构建「createSiliconFlowProvider」结果，不额外持有调用方的大对象。 */
function createSiliconFlowProvider(
  storedStudent: ManagedModelStudentRecord,
  connection: ProviderConnectionRecord,
  secretStore: HostSecretStore,
  urlPolicy: RemoteModelUrlPolicy,
): ChatCompletionsProvider {
  return new ChatCompletionsProvider({
    id: storedStudent.modelStudentId,
    name: storedStudent.displayName,
    sizeClass: storedStudent.sizeClass,
    ...(storedStudent.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: storedStudent.contextWindowTokens }),
    provider: {
      kind: "siliconflow",
      baseUrl: connection.baseUrl,
      model: storedStudent.model,
    },
    generationDefaults: { reasoningProfile: storedStudent.generationDefaults.reasoningProfile },
  }, {
    readBearerToken: /** 读取「readBearerToken」所需数据，并遵守作用域、分页与容量边界。 */
() => secretStore.read(connection.credentialRef),
    reasoning: {
      capability: storedStudent.snapshot.reasoning.capability,
      nativeByProfile: storedStudent.snapshot.reasoning.nativeByProfile,
    },
    includeStreamUsage: storedStudent.snapshot.usage,
    endpointResolver: /** 执行「endpointResolver」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(url) => urlPolicy.resolve(url),
  });
}

/** 执行「modelSizeClassEnv」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function modelSizeClassEnv(name: string, fallback: "small" | "large"): "small" | "large" {
  const value = process.env[name] ?? fallback;
  if (value !== "small" && value !== "large") {
    throw new Error(`${name} 必须是 small 或 large`);
  }
  return value;
}

/** 执行「integerEnv」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function integerEnv(name: string, fallback: number): number {
  const value = numberEnv(name, fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

/** 执行「optionalPositiveIntegerEnv」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function optionalPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

/** 执行「numberEnv」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} 必须是非负数`);
  }
  return value;
}

/** 执行「fileExists」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** 根目录 .env 中的项目路径相对仓库解析，不受 pnpm 子包 cwd 影响。 */
function workspacePath(value: string): string {
  return resolve(workspaceRoot, value);
}
