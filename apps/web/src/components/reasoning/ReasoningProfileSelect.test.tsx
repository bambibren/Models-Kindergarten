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

describe("ReasoningProfileSelect", () => {
  it("labels auto from the ModelStudent default and hides unsupported levels", () => {
    const profiles: ReasoningProfile[] = ["auto", "fast", "balanced", "deep", "max"];
    const html = renderToStaticMarkup(<ReasoningProfileSelect
      capability={capability}
      choices={profiles.map((profile) => ({ profile }))}
      onChange={() => undefined}
      value="auto"
    />);
    expect(html).toContain("跟随模型默认 · 均衡");
    expect(html).toContain("深入");
    expect(html).not.toContain("快速");
    expect(html).not.toContain("极致");
  });
});
