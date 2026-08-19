import { createHash } from "node:crypto";
import {
  parseContextPreviewInputV2,
  stableJson,
  type ContextPreviewResponseV2,
  type ExperimentTestDraftV2,
} from "@kindergarten/contracts";
import { buildContextSummary, buildRuntimeSystemPrompt, serializeModelInput } from "../runtime/agent-runtime.js";
import type { RuntimeCapabilityResolver } from "../capability/runtime-capability-resolver.js";
import { resolveReasoning } from "../reasoning/reasoning-resolver.js";
import { ApiProblemError } from "../server/api-problem.js";

/** 创建页预览与 prepare-run 共用这一条真实 Runtime/serializer 路径。 */
export class ContextPreviewService {
  constructor(private readonly resolver: RuntimeCapabilityResolver, ..._legacy: unknown[]) {}

  async preview(raw: unknown, ownerId = "local-admin"): Promise<ContextPreviewResponseV2> {
    let input;
    try { input = parseContextPreviewInputV2(raw); }
    catch (error) { throw invalid(publicMessage(error)); }
    return this.previewTest(input.promptText, input.test, ownerId);
  }

  async previewTest(
    promptText: string,
    test: ExperimentTestDraftV2,
    ownerId = "local-admin",
  ): Promise<ContextPreviewResponseV2> {
    const resolved = await this.resolver.preview(ownerId, test.policy, promptText, test.modelStudentId);
    const summary = this.resolver.modelSummary(test.modelStudentId);
    if (!summary || summary.status !== "ready") {
      throw new ApiProblemError(409, "EXPERIMENT_NOT_RUNNABLE", "ModelStudent 不可用", false);
    }
    const diagnostics: ContextPreviewResponseV2["diagnostics"] = [];
    const reasoningCapability = summary.supports.reasoning;
    if (test.reasoningProfile !== "auto" && !reasoningCapability.supportedProfiles.includes(test.reasoningProfile)) {
      diagnostics.push({
        code: "REASONING_PROFILE_UNSUPPORTED",
        path: "reasoningProfile",
        message: `当前 ModelStudent 不支持 ${test.reasoningProfile} 推理档位`,
      });
    }
    const usesTools = test.policy.builtinTools.some((item) => item.enabled)
      || test.policy.skillInstallationIds.length > 0
      || test.policy.mcps.some((item) => item.enabled && item.tools.some((tool) => tool.enabled));
    if (usesTools && !summary.supports.toolCalls) {
      diagnostics.push({
        code: "MODEL_TOOL_CALLS_UNSUPPORTED",
        path: "policy",
        message: "当前配置启用了 Tool，但目标 ModelStudent 未通过 Tool Call 体检",
      });
    }
    const resolvedReasoning = resolveReasoning({
      providerKind: resolved.model.student.provider.kind,
      model: resolved.model.student.provider.model,
      capability: reasoningCapability,
      modelDefault: resolved.model.student.generationDefaults.reasoningProfile ?? reasoningCapability.defaultProfile,
      ...(test.reasoningProfile === "auto" ? {} : { sessionOverride: test.reasoningProfile }),
      native: (profile) => resolved.model.nativeReasoning?.(profile) ?? {},
    });
    const built = await resolved.context.buildObserved([], promptText, new AbortController().signal);
    const tools = structuredClone(resolved.tools.registry.definitions);
    const systemPrompt = buildRuntimeSystemPrompt(resolved.agent.systemPrompt);
    const contextSummary = buildContextSummary("context-preview", resolved.model, systemPrompt, tools, built);
    const providerInput = serializeModelInput(resolved.model, { systemPrompt, messages: built.messages, tools, reasoning: resolvedReasoning });
    const providerInputHash = sha256(providerInput.value);
    const effectiveConfigurationHash = sha256(stableJson({
      modelStudentId: test.modelStudentId,
      providerKind: resolved.model.student.provider.kind,
      model: resolved.model.student.provider.model,
      resolvedReasoning,
      capabilityHash: resolved.capabilityHash,
      providerInputHash,
    }));
    return {
      schemaVersion: 2,
      runnable: diagnostics.length === 0,
      diagnostics,
      agentSnapshotHash: resolved.agentSnapshotHash,
      capabilityHash: resolved.capabilityHash,
      effectiveConfigurationHash,
      contextSummary,
      providerInput,
      providerInputHash,
      providerInputBytes: Buffer.byteLength(providerInput.value),
      resolvedReasoning,
      model: {
        modelStudentId: summary.modelStudentId,
        displayName: summary.displayName,
        providerKind: summary.providerKind,
        model: summary.model,
        ...(summary.contextWindowTokens === undefined ? {} : { contextWindowTokens: summary.contextWindowTokens }),
      },
      history: {
        configuredPolicy: structuredClone(test.policy.historyPolicy),
        actualHistoryTurns: 0,
      },
    };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function invalid(message: string) {
  return new ApiProblemError(400, "VALIDATION_FAILED", message, false);
}
function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
