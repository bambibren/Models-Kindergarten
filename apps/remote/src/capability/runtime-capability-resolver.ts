import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentInput, AgentRecord, ExperimentContextPolicy, ExperimentTestSnapshotV2 } from "@kindergarten/contracts";
import { stableJson } from "@kindergarten/contracts";
import type { AgentService } from "../agent/agent-service.js";
import { RuntimeCapabilityCatalog } from "./runtime-capability-catalog.js";
import { ContextAssembler, McpResourceContextSource, SkillCatalogContextSource } from "../conversation/context-assembler.js";
import type { McpClientManager } from "../mcp/mcp-client-manager.js";
import { McpToolProvider } from "../mcp/mcp-tool-provider.js";
import {
  modelInputMessageCapacity,
  type ModelProvider,
} from "../model/model-provider.js";
import { ModelStudentCatalog } from "../model/model-student-catalog.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import { SkillToolProvider } from "../skills/skill-tool-provider.js";
import { FileSandbox } from "../tools/sandbox.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { ToolRuntime } from "../tools/tool-runtime.js";
import type { TurnScope } from "../runtime/turn-scope.js";
import type { SkillInstallationService } from "../skills/skill-installation-service.js";
import { EnsureAgentSkillsToolProvider } from "../skills/ensure-agent-skills-tool.js";
import type { ArtifactService } from "../artifacts/artifact-service.js";
import { ArtifactToolProvider } from "../artifacts/artifact-tool-provider.js";
import { PptxBuildService } from "../pptx/pptx-build-service.js";
import { PptxToolProvider } from "../pptx/pptx-tool-provider.js";

/** 描述「ResolvedRuntimeCapabilities」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ResolvedRuntimeCapabilities {
  scope: TurnScope;
  agent: AgentRecord;
  agentSnapshotHash: string;
  model: ModelProvider;
  tools: ToolRuntime;
  context: ContextAssembler;
  fileSandbox: FileSandbox;
  capabilityHash: string;
  expectedFirstProviderInputHash?: string;
}

/** 描述「RuntimeCapabilityResolverPort」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface RuntimeCapabilityResolverPort {
  resolve(scope: TurnScope, currentUserMessage?: string): Promise<ResolvedRuntimeCapabilities>;
}

/** 描述「RuntimeCapabilityResolver」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class RuntimeCapabilityResolver implements RuntimeCapabilityResolverPort {
  private readonly models: ModelStudentCatalog;
  private experimentSnapshot?: (experimentId: string, testId: string) => Promise<ExperimentTestSnapshotV2 | undefined>;

  /** 初始化「RuntimeCapabilityResolver」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly agents: AgentService,
    modelOrCatalog: ModelProvider | ModelStudentCatalog,
    private readonly skills: SkillRegistry,
    private readonly mcp: McpClientManager,
    private readonly workspacesRoot: string,
    private readonly skillInstallations?: SkillInstallationService,
    private readonly artifacts?: ArtifactService,
  ) {
    this.models = modelOrCatalog instanceof ModelStudentCatalog
      ? modelOrCatalog
      : new ModelStudentCatalog(modelOrCatalog, "ready");
  }

  /** 执行「resolve」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async resolve(scope: TurnScope, currentUserMessage = ""): Promise<ResolvedRuntimeCapabilities> {
    const model = this.models.requireProvider(scope.modelStudentId);
    if (scope.experimentRunRef && this.experimentSnapshot) {
      const snapshot = await this.experimentSnapshot(scope.experimentRunRef.experimentId, scope.experimentRunRef.variantId);
      if (!snapshot) throw new Error("EXPERIMENT_SNAPSHOT_UNAVAILABLE: 冻结的 Test 快照不存在");
      if (snapshot.model.modelStudentId !== scope.modelStudentId) throw new Error("EXPERIMENT_SNAPSHOT_MISMATCH: ModelStudent 不一致");
      const input = this.agents.validateContextPolicy(snapshot.policy);
      const now = snapshot.frozenAt;
      const agent: AgentRecord = {
        schemaVersion: 1,
        agentId: snapshot.sourceAgent.agentId,
        ownerId: scope.ownerId,
        recordKind: "experiment_policy",
        ...agentRecordFields(input),
        createdAt: now,
        updatedAt: now,
      };
      const resolved = await this.resolveAgent(scope, agent, currentUserMessage, model);
      if (resolved.agentSnapshotHash !== snapshot.agentSnapshotHash || resolved.capabilityHash !== snapshot.model.capabilityHash) {
        throw new Error("EXPERIMENT_SNAPSHOT_STALE: 冻结依赖已变化，拒绝以不同输入运行");
      }
      return { ...resolved, expectedFirstProviderInputHash: snapshot.firstRequestPreview.providerInputHash };
    }
    const agent = await this.agents.get(scope.agentId, scope.ownerId);
    return this.resolveAgent(scope, agent, currentUserMessage, model);
  }

  /** 更新「setExperimentSnapshotResolver」对应状态，并保持写入顺序、原子性与容量约束。 */
setExperimentSnapshotResolver(
    resolver: (experimentId: string, testId: string) => Promise<ExperimentTestSnapshotV2 | undefined>,
  ): void {
    this.experimentSnapshot = resolver;
  }

  /** 执行「modelSummary」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
modelSummary(modelStudentId: string) {
    return this.models.get(modelStudentId);
  }

  /** 执行「preview」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async preview(
    ownerId: string,
    policy: ExperimentContextPolicy,
    prompt: string,
    modelStudentId = this.models.defaultProvider().student.id,
  ): Promise<ResolvedRuntimeCapabilities> {
    const model = this.models.requireProvider(modelStudentId);
    const input = this.agents.validateContextPolicy(policy);
    const now = new Date().toISOString();
    const agent: AgentRecord = {
      schemaVersion: 1,
      agentId: "context-preview",
      ownerId,
      recordKind: "experiment_policy",
      ...agentRecordFields(input),
      createdAt: now,
      updatedAt: now,
    };
    return this.resolveAgent({ schemaVersion: 1, ownerId, sessionId: "context-preview", turnId: "context-preview", purpose: "experiment", modelStudentId: model.student.id, agentId: agent.agentId }, agent, prompt, model);
  }

  /** 执行「resolveAgent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async resolveAgent(
    scope: TurnScope,
    agent: AgentRecord,
    currentUserMessage: string,
    model: ModelProvider,
  ): Promise<ResolvedRuntimeCapabilities> {
    const sandbox = new FileSandbox(join(this.workspacesRoot, scope.sessionId));
    await sandbox.initialize();
    const builtinBindings = new Map(agent.builtinTools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => [item.toolId, {
      enabled: item.enabled,
      permission: item.permission,
    }]));
    const installationIds = agent.skills.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.enabled).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.skillInstallationId);
    const skillNames = this.skillInstallations
      ? await this.skillInstallations.runtimeSkillNames(installationIds, scope.ownerId)
      : installationIds;
    const providers = [
      new ToolRegistry(sandbox, undefined, undefined, builtinBindings),
      new PptxToolProvider(new PptxBuildService(sandbox), builtinBindings),
      ...(this.artifacts ? [new ArtifactToolProvider(this.artifacts, scope, builtinBindings)] : []),
      new McpToolProvider(this.mcp, agent.mcps),
      new SkillToolProvider(this.skills, skillNames),
      ...(this.skillInstallations && currentUserMessage
        ? [new EnsureAgentSkillsToolProvider(this.skillInstallations, scope, currentUserMessage)]
        : []),
    ];
    const catalog = new RuntimeCapabilityCatalog(providers);
    const requestedMaxMessages = agent.historyPolicy.mode === "none"
      ? 1
      : Math.max(1, agent.historyPolicy.maxTurns * 8 + 1);
    const hardMaxMessages = modelInputMessageCapacity(
      model,
      catalog.definitions.length > 0,
    );
    const context = new ContextAssembler([
      new SkillCatalogContextSource(this.skills, skillNames),
      new McpResourceContextSource(this.mcp, agent.mcps),
    ], requestedMaxMessages, hardMaxMessages);
    const agentSnapshotHash = hash({
      name: agent.name,
      systemPrompt: agent.systemPrompt,
      builtinTools: agent.builtinTools,
      skills: agent.skills,
      mcps: agent.mcps,
      historyPolicy: agent.historyPolicy,
      memoryPolicy: agent.memoryPolicy,
    });
    return {
      scope,
      agent,
      agentSnapshotHash,
      model,
      tools: new ToolRuntime(catalog),
      context,
      fileSandbox: sandbox,
      capabilityHash: hash(catalog.capabilitySnapshot()),
    };
  }
}

/** 执行「agentRecordFields」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function agentRecordFields(input: AgentInput): Pick<AgentRecord, "name" | "description" | "systemPrompt" | "builtinTools" | "skills" | "mcps" | "historyPolicy" | "memoryPolicy"> {
  return {
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    systemPrompt: input.systemPrompt,
    builtinTools: input.builtinTools,
    skills: input.skillInstallationIds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skillInstallationId) => ({ skillInstallationId, enabled: true })),
    mcps: input.mcps,
    historyPolicy: input.historyPolicy,
    memoryPolicy: input.memoryPolicy,
  };
}

/** 判断「hash」对应条件，只返回判定结果且不修改输入状态。 */
function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
