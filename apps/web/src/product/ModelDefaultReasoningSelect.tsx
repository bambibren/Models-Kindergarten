import type { ConcreteReasoningProfile, ModelReasoningCapability } from "@kindergarten/contracts";
import { profileLabel } from "../reasoning/reasoning-config.js";

/** 渲染「ModelDefaultReasoningSelect」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ModelDefaultReasoningSelect({ capability, disabled = false, onChange, value }: {
  capability: ModelReasoningCapability;
  disabled?: boolean;
  onChange: (profile: ConcreteReasoningProfile) => void;
  value: ConcreteReasoningProfile;
}) {
  return <section className="product-admission-default-reasoning">
    <strong>模型默认思考设置</strong>
    <label>
      <span>新会话默认档位</span>
      <select
        aria-label="模型默认思考设置"
        disabled={disabled || capability.supportedProfiles.length <= 1}
        onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => onChange(event.target.value as ConcreteReasoningProfile)}
        value={value}
      >
        {capability.supportedProfiles.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(profile) => <option key={profile} value={profile}>
          {profileLabel(profile, capability)}
        </option>)}
      </select>
    </label>
    <p>会话选择“跟随模型默认”时使用这里的档位；会话中仍可临时切换到该模型已验证支持的其他档位。</p>
  </section>;
}
