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

describe("ModelDefaultReasoningSelect", () => {
  it("renders only concrete profiles verified for the current model", () => {
    const html = renderToStaticMarkup(<ModelDefaultReasoningSelect
      capability={capability}
      onChange={() => undefined}
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
