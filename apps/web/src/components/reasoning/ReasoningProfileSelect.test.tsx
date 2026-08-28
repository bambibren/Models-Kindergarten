import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ModelReasoningCapability, ReasoningProfile } from "@kindergarten/contracts";
import { ReasoningProfileSelect } from "./ReasoningProfileSelect.js";

const capability: ModelReasoningCapability = {
  schemaVersion: 1,
  control: "effort_levels",
  adjustable: true,
  supportedProfiles: ["balanced", "deep"],
  defaultProfile: "balanced",
};

describe("ReasoningProfileSelect", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("labels auto from the ModelStudent default and hides unsupported levels", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const profiles: ReasoningProfile[] = ["auto", "fast", "balanced", "deep", "max"];
    const html = renderToStaticMarkup(<ReasoningProfileSelect
      capability={capability}
      choices={profiles.map(/** 构造「choices」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(profile) => ({ profile }))}
      onChange={/** 构造「onChange」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined}
      value="auto"
    />);
    expect(html).toContain("跟随模型默认 · 均衡");
    expect(html).toContain("深入");
    expect(html).not.toContain("快速");
    expect(html).not.toContain("极致");
  });
});
