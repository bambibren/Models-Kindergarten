import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import {
  isReasoningProfile,
  type ModelReasoningCapability,
  type ReasoningProfile,
} from "@kindergarten/contracts";

export const reasoningProfileLabels: Record<ReasoningProfile, string> = {
  auto: "自动",
  fast: "快速",
  balanced: "均衡",
  deep: "深入",
  max: "极致",
};

export interface ReasoningConfigView {
  configId: string;
  currentProfile: ReasoningProfile;
  choices: Array<{ profile: ReasoningProfile; name: string; description?: string }>;
}

/**
 * Composer 只投影 Agent 通过 ACP 返回的 thought_level selector。
 * ModelStudent 能力用于隐藏固定模型并过滤不适用于当前模型的档位，不能自行补造协议选项。
 */
export function projectReasoningConfig(
  configOptions: SessionConfigOption[],
  capability?: ModelReasoningCapability,
): ReasoningConfigView | undefined {
  if (!capability?.adjustable) return undefined;
  const option = configOptions.find((candidate) => candidate.type === "select" && candidate.category === "thought_level");
  if (!option || option.type !== "select" || !isReasoningProfile(option.currentValue)) return undefined;
  const supported = new Set<ReasoningProfile>(["auto", ...capability.supportedProfiles]);
  const choices = flattenOptions(option.options)
    .filter((candidate): candidate is SessionConfigSelectOption & { value: ReasoningProfile } =>
      isReasoningProfile(candidate.value) && supported.has(candidate.value),
    )
    .map((candidate) => ({
      profile: candidate.value,
      name: candidate.value === "auto" ? reasoningAutoLabel(capability) : candidate.name,
      ...(candidate.description ? { description: candidate.description } : {}),
    }));
  if (choices.length < 2 || !choices.some((choice) => choice.profile === option.currentValue)) return undefined;
  return { configId: option.id, currentProfile: option.currentValue, choices };
}

export function availableReasoningProfiles(capability?: ModelReasoningCapability): ReasoningProfile[] {
  if (!capability?.adjustable) return [];
  return ["auto", ...capability.supportedProfiles.filter((profile, index, values) => values.indexOf(profile) === index)];
}

export function profileLabel(profile: ReasoningProfile, capability?: ModelReasoningCapability): string {
  if (capability?.control === "toggle") {
    if (profile === "fast") return "关闭思考";
    if (profile === "balanced") return "开启思考";
  }
  return reasoningProfileLabels[profile];
}

export function reasoningAutoLabel(capability?: ModelReasoningCapability): string {
  return capability
    ? `跟随模型默认 · ${profileLabel(capability.defaultProfile, capability)}`
    : "跟随模型默认";
}

function flattenOptions(options: Extract<SessionConfigOption, { type: "select" }>["options"]): SessionConfigSelectOption[] {
  return options.flatMap((option) => "options" in option ? option.options : [option]);
}
