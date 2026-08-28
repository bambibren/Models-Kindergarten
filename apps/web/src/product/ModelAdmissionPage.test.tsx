import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelAdmissionPage } from "./ModelAdmissionPage.js";

describe("ModelAdmissionPage", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("offers an optional, unprefilled context-window input", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
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
