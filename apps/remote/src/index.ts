import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import type { SecretStore } from "./mcp/secret-store.js";
import { EncryptedFileSecretStore } from "./secrets/encrypted-file-secret-store.js";
import { FileMasterKeySource } from "./secrets/file-master-key.js";
import { LegacyMacKeychainReader } from "./secrets/legacy-keychain-reader.js";
import { OllamaAdmissionAdapter } from "./model/ollama-admission-adapter.js";
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
import { LegacyOllamaMigration } from "./model/legacy-ollama-migration.js";
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
import { configuredSkillResourceFetchBase, configuredSkillResourceOrigins, SkillSourceUrlPolicy } from "./skills/skill-source-url.js";
import { registerSkillRoutes } from "./skills/skill-routes.js";
import { FileReferenceRepository } from "./files/file-reference-repository.js";
import { FileReferenceService } from "./files/file-reference-service.js";
import { registerFileRoutes } from "./files/file-routes.js";
import { FileSandbox } from "./tools/sandbox.js";
import { ExperimentRepository } from "./experiments/experiment-repository.js";
import { ExperimentService } from "./experiments/experiment-service.js";
import { EvaluationModule } from "./evaluation/evaluation-module.js";
import { reconcileTurnEffectScoreResults, registerTurnEffectScoreRoutes } from "./evaluation/turn-effect-score-routes.js";
import { registerScoreResultRoutes } from "./evaluation/score-result-routes.js";
import { registerExperimentRoutes } from "./experiments/experiment-routes.js";
import { ContextPreviewService } from "./experiments/context-preview-service.js";
import { AnnotationWorksheetGenerator } from "./experiments/annotation-worksheet-generator.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { ToolRuntime } from "./tools/tool-runtime.js";
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
import {
  assertImplementedDeploymentFeatures,
  readDeploymentConfig,
} from "./config/deployment-config.js";
import { PasswordAuthStore } from "./auth/password-auth-store.js";
import { AuthService } from "./auth/auth-service.js";
import { AUTH_PUBLIC_PATHS, registerAuthRoutes } from "./auth/auth-routes.js";
import { localPrincipal } from "./server/local-principal.js";
import type { AgentInput, Principal } from "@kindergarten/contracts";

const workspaceRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const deployment = readDeploymentConfig(process.env, process.cwd(), workspaceRoot);
assertImplementedDeploymentFeatures(deployment);
const { port, host, dataDir, sandboxDir, userSkillsDir } = deployment;
const modelStudents = new ModelStudentCatalog();
const sandbox = new FileSandbox(sandboxDir);
await sandbox.initialize();
const evaluation = new EvaluationModule(resolve(dataDir, "evaluation"));
await evaluation.initialize();
const artifacts = new ArtifactService(
  new ArtifactRepository(resolve(dataDir, "artifacts.json")),
  new ArtifactBlobStore(resolve(dataDir, "artifact-blobs")),
  resolve(dataDir, "workspaces"),
);
const secrets = new EncryptedFileSecretStore(
  new FileMasterKeySource(deployment.masterKeyFile),
  deployment.credentialVaultFile,
  new LegacyMacKeychainReader(),
);
await secrets.initialize();
const allowManagedPrivateNetwork = deployment.managedEndpointPolicy === "any-network";
const modelUrlPolicy = new RemoteModelUrlPolicy({
  allowPrivateNetwork: allowManagedPrivateNetwork,
});
const modelAdmissionRepository = new ModelAdmissionRepository(
  resolve(dataDir, "model-student-tests.json"),
  resolve(dataDir, "model-admission-catalog.json"),
);
const mcp = new McpClientManager(
  new McpConfigStore(resolve(process.env.MCP_CONFIG_PATH ?? `${dataDir}/mcp/config.json`)),
  secrets,
  new SdkMcpConnector(secrets, sandbox.root, {
    allowPrivateNetwork: allowManagedPrivateNetwork,
  }),
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
  { allowInsecureHttp: process.env.ALLOW_INSECURE_SKILL_RESOURCE_ORIGINS === "true" },
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
const agentRepository = new AgentRepository(agentStoreFile);
let skillInstallations: SkillInstallationService;
let mcpManagement: McpManagementService | undefined;
const agentService = new AgentService(agentRepository, {
  builtinToolIds: /** 执行「builtinToolIds」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => [
    ...new ToolRegistry(sandbox).definitions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.function.name),
    ...ARTIFACT_TOOL_IDS,
    ...PPTX_TOOL_IDS,
  ],
  builtinSkills: () => skills.builtinOptions(),
  readySkillInstallationIds: /** 读取「readySkillInstallationIds」所需数据，并遵守作用域、分页与容量边界。 */
(ownerId) => skillInstallations?.readyInstallationIds(ownerId) ?? Promise.resolve([]),
  mcpCapabilities: /** 执行「mcpCapabilities」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(ownerId) => mcpManagement?.capabilities(ownerId) ?? Promise.resolve([]),
  skillInstallationIds: /** 读取账号安装记录，只用于区分“已删除”和“暂不可用”。 */
(ownerId) => skillInstallations?.installationIds(ownerId) ?? Promise.resolve([]),
  mcpInstallationIds: /** 读取账号安装记录，只用于区分“已删除”和“暂不可用”。 */
(ownerId) => mcpManagement?.installationIds(ownerId) ?? Promise.resolve([]),
});
skillInstallations = new SkillInstallationService(
  skillInstallationRepository,
  new SkillDiscovery(userSkillsDir),
  new SkillInstaller(
    userSkillsDir,
    skillLock,
    fetch,
    configuredSkillResourceFetchBase(process.env.SKILL_RESOURCE_FETCH_BASE),
  ),
  skills,
  agentService,
  skillSourcePolicy,
);
await skillInstallations.importExisting();
await skillInstallations.migrateBuiltinInstallations();
mcpManagement = new McpManagementService(
  new McpManagementRepository(resolve(dataDir, "mcp-tests.json"), resolve(dataDir, "mcp-installations.json")),
  mcp,
  agentService,
);
await mcpManagement.importExisting();
const defaultAgentInput = async (ownerId: string): Promise<AgentInput> => ({
    name: "系统默认 Agent",
    description: "MK 为每个账号提供的初始 Agent",
    systemPrompt: process.env.AGENT_SYSTEM_PROMPT ?? DEFAULT_AGENT_SYSTEM_PROMPT,
    builtinTools: [
      ...new ToolRegistry(sandbox).definitions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.function.name),
      ...ARTIFACT_TOOL_IDS,
      ...PPTX_TOOL_IDS,
    ].map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(toolId) => ({
      toolId,
      enabled: true,
      permission: "allow",
    })),
    builtinSkillIds: skills.builtinOptions()
      .filter((item) => capabilityConfig.agentCapabilities.skills.includes(item.name))
      .map((item) => item.skillId),
    skillInstallationIds: (await skillInstallations.list(ownerId))
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.state === "ready" && capabilityConfig.agentCapabilities.skills.includes(item.skillName))
      .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.skillInstallationId),
    mcps: [],
    historyPolicy: { mode: "recent_turns", maxTurns: 12 },
    memoryPolicy: { mode: "off" },
  });
await agentService.reconcileCapabilities(localPrincipal.principalId);
const startupDefaultAgentInput = await defaultAgentInput(localPrincipal.principalId);
await agentService.migrateSystemDefaultTools(startupDefaultAgentInput.builtinTools);
let defaultAgent = await agentService.ensureDefault(startupDefaultAgentInput, localPrincipal.principalId);
if (defaultAgent) {
  const systemPrompt = removeLegacyModelIdentity(defaultAgent.systemPrompt);
  if (systemPrompt !== defaultAgent.systemPrompt) {
    defaultAgent = await agentService.update(defaultAgent.agentId, {
      name: defaultAgent.name,
      ...(defaultAgent.description ? { description: defaultAgent.description } : {}),
      systemPrompt,
      builtinTools: defaultAgent.builtinTools,
      builtinSkillIds: defaultAgent.builtinSkills
        .filter((item) => item.enabled)
        .map((item) => item.skillId),
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
agentService.protect(defaultAgent.agentId);
const sessions = new SessionRepository(dataDir, {
  ownerId: "local-admin",
  modelStudentId: "local-coder-student",
  agentId: defaultAgent?.agentId ?? "unavailable-agent",
});
await sessions.persistMigrations();
const recoveredTurns = await sessions.recoverInterruptedTurns();
if (recoveredTurns > 0) console.warn(`已将 ${recoveredTurns} 个重启前未结束的 Turn 标记为 interrupted`);
const legacyOllamaMigrated = await new LegacyOllamaMigration(
  modelAdmissionRepository,
  (modelStudentId) => sessions.usesModelStudent(modelStudentId),
).migrate();
if (legacyOllamaMigrated) {
  console.log("已把历史 Session 引用的内置 Ollama 模型转换为普通入园记录");
}
const modelAdmissionAdapters = new ModelAdmissionAdapterRegistry([
  new OllamaAdmissionAdapter(),
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
  evaluation,
  new AnnotationWorksheetGenerator(modelStudents),
  contextPreviews,
);
await experimentService.reconcileScoreResults().catch((error) => {
  console.warn(`上下文实验原子评分迁移失败：${error instanceof Error ? error.message : String(error)}`);
});
await reconcileTurnEffectScoreResults(sessions, evaluation, agentService).catch((error) => {
  console.warn(`单轮原子评分迁移失败：${error instanceof Error ? error.message : String(error)}`);
});
resolver.setExperimentSnapshotResolver(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(experimentId, testId) => experimentService.snapshot(experimentId, testId));
const runtime = new AgentRuntime(
  undefined,
  new ToolRuntime(catalog),
  context,
  evaluation,
  resolver,
);
const authStore = new PasswordAuthStore(
  resolve(dataDir, "auth/users.json"),
  resolve(dataDir, "auth/sessions.json"),
);
const auth = new AuthService(deployment.authMode, authStore);
const control = new ControlApi({
  allowedOrigins: (process.env.CONTROL_ALLOWED_ORIGINS ?? deployment.publicOrigin ?? "http://127.0.0.1:5173")
    .split(",").map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.trim()).filter(Boolean),
  ...(deployment.authMode === "required" ? { resolvePrincipal: (request: Request) => auth.resolve(request) } : {}),
  publicPaths: AUTH_PUBLIC_PATHS,
});
registerAuthRoutes(control.router, auth);
registerAgentRoutes(control.router, agentService, { defaultAgentInput });
registerSessionRoutes(control.router, sessions, new SessionLaunchService(resolve(dataDir, "session-launches.json"), agentService, modelStudents, artifacts));
registerTurnEffectScoreRoutes(control.router, sessions, evaluation, agentService);
registerSkillRoutes(control.router, skillInstallations);
registerMcpRoutes(control.router, mcpManagement);
registerModelAdmissionRoutes(control.router, modelAdmission);
registerScoreResultRoutes(control.router, evaluation, modelAdmission);
registerExperimentRoutes(control.router, experimentService, contextPreviews);
const fileReferences = new FileReferenceService(
  new FileReferenceRepository(resolve(dataDir, "file-references.json")),
  resolve(dataDir, "workspaces"),
  resolve(dataDir, "file-blobs"),
);
registerFileRoutes(control.router, fileReferences);
registerArtifactRoutes(control.router, artifacts, new OnlyOfficePreviewService());
const createAgent = (principal: Principal) => {
  const bindings = new SessionBindingService({
    workspaceCwd: "/workspace",
    ownerId: principal.principalId,
    agentExists: async (id) => Boolean(await agentService.get(id, principal.principalId).catch(() => undefined)),
    modelStudentReady: async (id) =>
      modelStudents.isReady(id, principal.principalId),
    experimentBinding: (experimentId, variantId) =>
      experimentService.binding(experimentId, variantId, principal.principalId),
  });
  return new KindergartenAgent(
    sessions,
    runtime,
    bindings,
    experimentService,
    modelStudents,
    artifacts,
    principal.principalId,
  ).createApp();
};
const agent = createAgent(localPrincipal);
const evaluationHttp = {
  fetch: async (request: Request, principal?: Principal) => {
    if (deployment.authMode === "required" && principal) {
      const match = new URL(request.url).pathname.match(
        /^\/api\/evaluation\/v1\/turn-evaluations\/([^/]+)\/[^/]+$/u,
      );
      if (match?.[1]) {
        const session = await sessions.getMetadata(decodeURIComponent(match[1])).catch(() => undefined);
        if (!session || session.ownerId !== principal.principalId) {
          return Response.json({ error: "尚未生成本轮评测" }, { status: 404 });
        }
      }
    }
    return evaluation.fetch(request);
  },
};
const server = new RemoteServer(agent, {
  configuredModels: String(modelStudents.all().length),
  readyModels: String(modelStudents.all().filter((item) => item.status === "ready").length),
}, control, evaluationHttp, {
  dataDirectory: true,
  modelCatalog: true,
  secretStore: true,
}, deployment.authMode === "required" ? {
  resolve: (request) => auth.resolve(request),
  createAgent,
} : undefined);

await server.listen(host, port);
console.log(`Kindergarten Remote: ws://${host}:${port}/acp`);

console.log(`Deployment profile: ${deployment.profile}`);
console.log(`ModelStudents: ${modelStudents.all().length} configured`);
console.log(`Sandbox: ${sandbox.root}`);
console.log(`Evaluation: ${evaluation.available ? "ready" : "degraded"}`);
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

/** 根据已校验输入构建「createResponsesProvider」结果，不额外持有调用方的大对象。 */
function createResponsesProvider(
  storedStudent: ManagedModelStudentRecord,
  connection: ProviderConnectionRecord,
  secretStore: SecretStore,
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
() => secretStore.read(requireCredentialRef(connection)),
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
  secretStore: SecretStore,
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
() => secretStore.read(requireCredentialRef(connection)),
    reasoning: {
      capability: storedStudent.snapshot.reasoning.capability,
      nativeByProfile: storedStudent.snapshot.reasoning.nativeByProfile,
    },
    includeStreamUsage: storedStudent.snapshot.usage,
    endpointResolver: /** 执行「endpointResolver」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(url) => urlPolicy.resolve(url),
  });
}

/** 需要 Bearer Token 的协议在 Provider 构造边界断言凭据，Ollama 不经过这里。 */
function requireCredentialRef(connection: ProviderConnectionRecord) {
  if (!connection.credentialRef) throw new Error(`ProviderConnection 缺少凭据: ${connection.connectionId}`);
  return connection.credentialRef;
}

/** 根目录 .env 中的项目路径相对仓库解析，不受 pnpm 子包 cwd 影响。 */
function workspacePath(value: string): string {
  return resolve(workspaceRoot, value);
}
