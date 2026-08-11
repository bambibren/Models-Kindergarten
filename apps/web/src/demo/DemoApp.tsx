import { ContextLabPage } from "./context-lab/ContextLabPage.js";
import { AgentEditorPage } from "./agent-editor/AgentEditorPage.js";
import { MePage } from "./me/MePage.js";
import { ModelHomePage } from "./model-home/ModelHomePage.js";
import { SessionDemoPage } from "./session/SessionDemoPage.js";
import { McpEditorPage } from "./mcp/McpEditorPage.js";
import { ModelAdmissionPage } from "./model-admission/ModelAdmissionPage.js";
import { DemoTopNav } from "./shared/DemoTopNav.js";
import "./demo.css";

const routes = new Set([
  "/demo/model-home",
  "/demo/model-admission",
  "/demo/session",
  "/demo/context-lab",
  "/demo/agent-editor",
  "/demo/me",
  "/demo/mcp",
]);

export function isDemoRoute(pathname: string): boolean {
  return routes.has(normalize(pathname));
}

export function DemoApp() {
  const path = normalize(location.pathname);
  if (path === "/demo/model-home") return <ModelHomePage />;
  if (path === "/demo/model-admission") return <ModelAdmissionPage />;
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

function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}
