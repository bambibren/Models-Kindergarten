import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentInput, AgentRecord, ExperimentContextPolicy } from "@kindergarten/contracts";
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

export interface ResolvedRuntimeCapabilities {
  scope: TurnScope;
  agent: AgentRecord;
  agentSnapshotHash: string;
  model: ModelProvider;
  tools: ToolRuntime;
  context: ContextAssembler;
  fileSandbox: FileSandbox;
  capabilityHash: string;
}

export interface RuntimeCapabilityResolverPort {
  resolve(scope: TurnScope, currentUserMessage?: string): Promise<ResolvedRuntimeCapabilities>;
}

export class RuntimeCapabilityResolver implements RuntimeCapabilityResolverPort {
  private readonly models: ModelStudentCatalog;

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

  async resolve(scope: TurnScope, currentUserMessage = ""): Promise<ResolvedRuntimeCapabilities> {
    const model = this.models.requireProvider(scope.modelStudentId);
    const agent = await this.agents.get(scope.agentId, scope.ownerId);
    return this.resolveAgent(scope, agent, currentUserMessage, model);
  }

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

  private async resolveAgent(
    scope: TurnScope,
    agent: AgentRecord,
    currentUserMessage: string,
    model: ModelProvider,
  ): Promise<ResolvedRuntimeCapabilities> {
    const sandbox = new FileSandbox(join(this.workspacesRoot, scope.sessionId));
    await sandbox.initialize();
    const builtinBindings = new Map(agent.builtinTools.map((item) => [item.toolId, {
      enabled: item.enabled,
      permission: item.permission,
    }]));
    const installationIds = agent.skills.filter((item) => item.enabled).map((item) => item.skillInstallationId);
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

function agentRecordFields(input: AgentInput): Pick<AgentRecord, "name" | "description" | "systemPrompt" | "builtinTools" | "skills" | "mcps" | "historyPolicy" | "memoryPolicy"> {
  return {
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    systemPrompt: input.systemPrompt,
    builtinTools: input.builtinTools,
    skills: input.skillInstallationIds.map((skillInstallationId) => ({ skillInstallationId, enabled: true })),
    mcps: input.mcps,
    historyPolicy: input.historyPolicy,
    memoryPolicy: input.memoryPolicy,
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
