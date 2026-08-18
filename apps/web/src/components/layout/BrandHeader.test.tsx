import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionSidebar } from "./SessionSidebar.js";
import { ProductNav } from "../../product/ProductNav.js";

describe("brand headers", () => {
  it("uses the requested Chinese title and English subtitle on the session header", () => {
    const html = renderToStaticMarkup(<SessionSidebar sessions={[]} activeId={null} disabled={false} onCreate={() => undefined} onSelect={() => undefined} />);
    expect(html).toContain("模型幼儿园");
    expect(html).toContain("Models KinderGarten");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("Local ACP classroom");
  });

  it("uses the requested Chinese title and English subtitle on the home header", () => {
    const html = renderToStaticMarkup(<ProductNav active="home" />);
    expect(html).toContain("模型幼儿园");
    expect(html).toContain("Models KinderGarten");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("ModelStudent</strong>");
  });
});
