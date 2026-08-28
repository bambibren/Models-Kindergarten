import type {
  ModelReasoningCapability,
  ConcreteReasoningProfile,
  ResolvedReasoningSnapshot,
} from "@kindergarten/contracts";
import { resolveSupportedReasoningProfile } from "@kindergarten/contracts";

/** 描述「ReasoningResolutionInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ReasoningResolutionInput {
  providerKind: string;
  model: string;
  capability: ModelReasoningCapability;
  modelDefault: ConcreteReasoningProfile;
  sessionOverride?: ConcreteReasoningProfile;
  native(profile: ConcreteReasoningProfile): Record<string, string | number | boolean>;
}

/** 优先级只在 Turn 边界解析一次，保证执行中配置变化不会污染当前 Turn。 */
export function resolveReasoning(input: ReasoningResolutionInput): ResolvedReasoningSnapshot {
  const requestedProfile = input.sessionOverride ?? "auto";
  const source = input.sessionOverride !== undefined
    ? "session_override"
    : "model_default";
  const desired = requestedProfile === "auto" ? input.modelDefault : requestedProfile;
  const resolvedProfile = resolveSupportedReasoningProfile(desired, input.capability.supportedProfiles);
  return {
    schemaVersion: 1,
    requestedProfile,
    resolvedProfile,
    source,
    providerKind: input.providerKind,
    model: input.model,
    native: structuredClone(input.native(resolvedProfile)),
  };
}
