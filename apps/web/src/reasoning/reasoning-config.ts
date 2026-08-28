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

/** 描述「ReasoningConfigView」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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
  const option = configOptions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.type === "select" && candidate.category === "thought_level");
  if (!option || option.type !== "select" || !isReasoningProfile(option.currentValue)) return undefined;
  const supported = new Set<ReasoningProfile>(["auto", ...capability.supportedProfiles]);
  const choices = flattenOptions(option.options)
    .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate): candidate is SessionConfigSelectOption & { value: ReasoningProfile } =>
      isReasoningProfile(candidate.value) && supported.has(candidate.value),
    )
    .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(candidate) => ({
      profile: candidate.value,
      name: candidate.value === "auto" ? reasoningAutoLabel(capability) : candidate.name,
      ...(candidate.description ? { description: candidate.description } : {}),
    }));
  if (choices.length < 2 || !choices.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(choice) => choice.profile === option.currentValue)) return undefined;
  return { configId: option.id, currentProfile: option.currentValue, choices };
}

/** 执行「availableReasoningProfiles」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function availableReasoningProfiles(capability?: ModelReasoningCapability): ReasoningProfile[] {
  if (!capability?.adjustable) return [];
  return ["auto", ...capability.supportedProfiles.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(profile, index, values) => values.indexOf(profile) === index)];
}

/** 执行「profileLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function profileLabel(profile: ReasoningProfile, capability?: ModelReasoningCapability): string {
  if (capability?.control === "toggle") {
    if (profile === "fast") return "关闭思考";
    if (profile === "balanced") return "开启思考";
  }
  return reasoningProfileLabels[profile];
}

/** 执行「reasoningAutoLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function reasoningAutoLabel(capability?: ModelReasoningCapability): string {
  return capability
    ? `跟随模型默认 · ${profileLabel(capability.defaultProfile, capability)}`
    : "跟随模型默认";
}

/** 执行「flattenOptions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function flattenOptions(options: Extract<SessionConfigOption, { type: "select" }>["options"]): SessionConfigSelectOption[] {
  return options.flatMap(/** 执行「flattenOptions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(option) => "options" in option ? option.options : [option]);
}
