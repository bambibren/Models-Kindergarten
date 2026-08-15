import { isRecord } from "./common.js";

/** 产品级推理语义；Provider 原生枚举只存在于能力和 Turn 快照中。 */
export type ReasoningProfile = "auto" | "fast" | "balanced" | "deep" | "max";
export type ConcreteReasoningProfile = Exclude<ReasoningProfile, "auto">;

export const REASONING_PROFILES = ["auto", "fast", "balanced", "deep", "max"] as const;
export const CONCRETE_REASONING_PROFILES = ["fast", "balanced", "deep", "max"] as const;

export type ReasoningControl = "fixed" | "toggle" | "effort_levels" | "token_budget";

/** ModelStudent 的只读能力声明，不包含 Agent 或 Session 的选择。 */
export interface ModelReasoningCapability {
  schemaVersion: 1;
  control: ReasoningControl;
  adjustable: boolean;
  supportedProfiles: ConcreteReasoningProfile[];
  defaultProfile: ConcreteReasoningProfile;
  native?: {
    parameter: string;
    values?: Array<string | number | boolean>;
    minBudget?: number;
    maxBudget?: number;
  };
}

/** Turn 开始前解析并冻结；后续 ModelStudent 或 Session 改值都不能改变它。 */
export interface ResolvedReasoningSnapshot {
  schemaVersion: 1;
  requestedProfile: ReasoningProfile;
  resolvedProfile: ConcreteReasoningProfile;
  source: "session_override" | "model_default";
  providerKind: string;
  model: string;
  native: Record<string, string | number | boolean>;
}

export function isReasoningProfile(value: unknown): value is ReasoningProfile {
  return typeof value === "string" && (REASONING_PROFILES as readonly string[]).includes(value);
}

export function parseReasoningProfile(value: unknown, field = "reasoningProfile"): ReasoningProfile {
  if (isReasoningProfile(value)) return value;
  throw new Error(`${field} 必须是 auto、fast、balanced、deep 或 max`);
}

export function isConcreteReasoningProfile(value: unknown): value is ConcreteReasoningProfile {
  return typeof value === "string" && (CONCRETE_REASONING_PROFILES as readonly string[]).includes(value);
}

export function parseConcreteReasoningProfile(value: unknown, field = "reasoningProfile"): ConcreteReasoningProfile {
  if (isConcreteReasoningProfile(value)) return value;
  throw new Error(`${field} 必须是 fast、balanced、deep 或 max`);
}

/** Runtime 与 Web 共用的确定性落档规则；距离相同时选择更低档，避免 UI 与真实请求漂移。 */
export function resolveSupportedReasoningProfile(
  desired: ConcreteReasoningProfile,
  supported: readonly ConcreteReasoningProfile[],
): ConcreteReasoningProfile {
  if (supported.length === 0) throw new Error("Model reasoning capability 至少需要一个 concrete profile");
  if (supported.includes(desired)) return desired;
  const order = CONCRETE_REASONING_PROFILES;
  const desiredIndex = order.indexOf(desired);
  return [...supported].toSorted((left, right) => {
    const leftDistance = Math.abs(order.indexOf(left) - desiredIndex);
    const rightDistance = Math.abs(order.indexOf(right) - desiredIndex);
    return leftDistance - rightDistance || order.indexOf(left) - order.indexOf(right);
  })[0]!;
}

export function readModelReasoningCapability(value: unknown): ModelReasoningCapability {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isControl(value.control)) {
    throw new Error("Model reasoning capability 格式无效");
  }
  if (typeof value.adjustable !== "boolean" || !Array.isArray(value.supportedProfiles)) {
    throw new Error("Model reasoning capability 格式无效");
  }
  const supportedProfiles = [...new Set(
    value.supportedProfiles.map((item) => parseConcreteReasoningProfile(item, "supportedProfiles")),
  )];
  if (supportedProfiles.length === 0) throw new Error("supportedProfiles 至少需要一个档位");
  const defaultProfile = parseConcreteReasoningProfile(value.defaultProfile, "defaultProfile");
  if (!supportedProfiles.includes(defaultProfile)) throw new Error("defaultProfile 必须属于 supportedProfiles");
  if (value.adjustable !== (supportedProfiles.length > 1)) throw new Error("adjustable 与 supportedProfiles 不一致");
  if (value.control === "fixed" && supportedProfiles.length !== 1) throw new Error("fixed capability 只能有一个档位");
  if (
    value.control === "toggle"
    && (supportedProfiles.length !== 2 || supportedProfiles[0] !== "fast" || supportedProfiles[1] !== "balanced")
  ) {
    throw new Error("toggle capability 必须按 fast、balanced 表达关闭与开启");
  }
  return {
    schemaVersion: 1,
    control: value.control,
    adjustable: value.adjustable,
    supportedProfiles,
    defaultProfile,
    ...(value.native === undefined ? {} : { native: readNativeCapability(value.native) }),
  };
}

function isControl(value: unknown): value is ReasoningControl {
  return value === "fixed" || value === "toggle" || value === "effort_levels" || value === "token_budget";
}

function readNativeCapability(value: unknown): NonNullable<ModelReasoningCapability["native"]> {
  if (!isRecord(value) || typeof value.parameter !== "string" || value.parameter.trim().length === 0) {
    throw new Error("native reasoning capability 格式无效");
  }
  if (value.values !== undefined && (!Array.isArray(value.values) || value.values.some((item) =>
    typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean"))) {
    throw new Error("native.values 只能包含字符串、数字或布尔值");
  }
  for (const field of ["minBudget", "maxBudget"] as const) {
    if (value[field] !== undefined && (!Number.isInteger(value[field]) || Number(value[field]) < 0)) {
      throw new Error(`native.${field} 必须是非负整数`);
    }
  }
  const minBudget = typeof value.minBudget === "number" ? value.minBudget : undefined;
  const maxBudget = typeof value.maxBudget === "number" ? value.maxBudget : undefined;
  if (minBudget !== undefined && maxBudget !== undefined && minBudget > maxBudget) {
    throw new Error("native reasoning budget 范围无效");
  }
  return {
    parameter: value.parameter,
    ...(value.values ? { values: [...value.values] as Array<string | number | boolean> } : {}),
    ...(minBudget !== undefined ? { minBudget } : {}),
    ...(maxBudget !== undefined ? { maxBudget } : {}),
  };
}
