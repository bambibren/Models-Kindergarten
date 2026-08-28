import { ContextLabPage } from "./context-lab/ContextLabPage.js";
import { AgentEditorPage } from "./agent-editor/AgentEditorPage.js";
import { MePage } from "./me/MePage.js";
import { ModelHomePage } from "./model-home/ModelHomePage.js";
import { SessionDemoPage } from "./session/SessionDemoPage.js";
import { McpEditorPage } from "./mcp/McpEditorPage.js";
import { DemoTopNav } from "./shared/DemoTopNav.js";
import "./demo.css";

const routes = new Set([
  "/demo/model-home",
  "/demo/session",
  "/demo/context-lab",
  "/demo/agent-editor",
  "/demo/me",
  "/demo/mcp",
]);

/** 判断「isDemoRoute」对应条件，只返回判定结果且不修改输入状态。 */
export function isDemoRoute(pathname: string): boolean {
  return routes.has(normalize(pathname));
}

/** 渲染「DemoApp」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function DemoApp() {
  const path = normalize(location.pathname);
  if (path === "/demo/model-home") return <ModelHomePage />;
  if (path === "/demo/session") return <SessionDemoPage />;
  if (path === "/demo/context-lab") return <ContextLabPage />;
  if (path === "/demo/agent-editor") return <AgentEditorPage />;
  if (path === "/demo/me") return <MePage />;
  if (path === "/demo/mcp") return <McpEditorPage />;
  return <main className="mk-demo-app mk-demo-not-found">
    <DemoTopNav active="home" />
    <section><strong>Demo 页面不存在</strong><a href="/demo/model-home">返回模型主页</a></section>
  </main>;
}

/** 校验并规范化「normalize」输入，非法数据直接返回明确错误。 */
function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}
