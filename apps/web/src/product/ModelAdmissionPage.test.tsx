import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelAdmissionPage } from "./ModelAdmissionPage.js";

describe("ModelAdmissionPage", () => {
  it("offers an optional, unprefilled context-window input", () => {
    const html = renderToStaticMarkup(<ModelAdmissionPage />);

    expect(html).toContain("上下文窗口（tokens，可选）");
    expect(html).toContain('id="model-context-window-tokens"');
    expect(html).toContain('type="number"');
    expect(html).toContain('min="1"');
    expect(html).toContain('step="1"');
    expect(html).toContain("MK 不会探测、预填或推断这个数值");
    expect(html).toContain('placeholder="输入正整数"');
    expect(html).not.toContain('value="262144"');
  });
});
