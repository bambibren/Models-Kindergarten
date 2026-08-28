import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ModelReasoningCapability } from "@kindergarten/contracts";
import { ModelDefaultReasoningSelect } from "./ModelDefaultReasoningSelect.js";

const capability: ModelReasoningCapability = {
  schemaVersion: 1,
  control: "effort_levels",
  adjustable: true,
  supportedProfiles: ["balanced", "deep"],
  defaultProfile: "balanced",
};

describe("ModelDefaultReasoningSelect", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("renders only concrete profiles verified for the current model", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<ModelDefaultReasoningSelect
      capability={capability}
      onChange={/** 构造「onChange」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined}
      value="balanced"
    />);
    expect(html).toContain("模型默认思考设置");
    expect(html).toContain("均衡");
    expect(html).toContain("深入");
    expect(html).not.toContain("快速");
    expect(html).not.toContain("极致");
    expect(html).not.toContain('value="auto"');
  });
});
