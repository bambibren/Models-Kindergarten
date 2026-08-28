import { Brain, ChevronDown, LoaderCircle } from "lucide-react";
import {
  type ModelReasoningCapability,
  type ReasoningProfile,
} from "@kindergarten/contracts";
import { profileLabel, reasoningAutoLabel } from "../../reasoning/reasoning-config.js";

/** 渲染「ReasoningProfileSelect」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ReasoningProfileSelect({
  busy = false,
  capability,
  choices,
  className = "",
  disabled = false,
  label = "当前会话思考强度",
  onChange,
  value,
}: {
  busy?: boolean;
  capability?: ModelReasoningCapability;
  choices: Array<{ profile: ReasoningProfile; name?: string }>;
  className?: string;
  disabled?: boolean;
  label?: string;
  onChange: (profile: ReasoningProfile) => void;
  value: ReasoningProfile;
}) {
  const supported = capability
    ? new Set<ReasoningProfile>(["auto", ...capability.supportedProfiles])
    : undefined;
  const visibleChoices = supported ? choices.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(choice) => supported.has(choice.profile)) : choices;
  return <label className={`reasoning-profile-select ${className}`.trim()}>
    {busy ? <LoaderCircle className="reasoning-profile-spinner" size={13} /> : <Brain size={13} />}
    <span className="sr-only">{label}</span>
    <select
      aria-label={label}
      disabled={disabled || busy}
      value={value}
      onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => onChange(event.target.value as ReasoningProfile)}
    >
      {visibleChoices.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(choice) => <option key={choice.profile} value={choice.profile}>
        {choice.profile === "auto"
          ? reasoningAutoLabel(capability)
          : choice.name ?? profileLabel(choice.profile, capability)}
      </option>)}
    </select>
    <ChevronDown aria-hidden size={12} />
  </label>;
}
