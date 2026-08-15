import { Brain, ChevronDown, LoaderCircle } from "lucide-react";
import {
  type ModelReasoningCapability,
  type ReasoningProfile,
} from "@kindergarten/contracts";
import { profileLabel, reasoningAutoLabel } from "../../reasoning/reasoning-config.js";

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
  const visibleChoices = supported ? choices.filter((choice) => supported.has(choice.profile)) : choices;
  return <label className={`reasoning-profile-select ${className}`.trim()}>
    {busy ? <LoaderCircle className="reasoning-profile-spinner" size={13} /> : <Brain size={13} />}
    <span className="sr-only">{label}</span>
    <select
      aria-label={label}
      disabled={disabled || busy}
      value={value}
      onChange={(event) => onChange(event.target.value as ReasoningProfile)}
    >
      {visibleChoices.map((choice) => <option key={choice.profile} value={choice.profile}>
        {choice.profile === "auto"
          ? reasoningAutoLabel(capability)
          : choice.name ?? profileLabel(choice.profile, capability)}
      </option>)}
    </select>
    <ChevronDown aria-hidden size={12} />
  </label>;
}
