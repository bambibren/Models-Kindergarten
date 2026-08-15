import { createRoot } from "react-dom/client";
import App from "./App.js";
import { RenderErrorBoundary } from "./components/errors/RenderErrorBoundary.js";
import { DemoApp, isDemoRoute } from "./demo/DemoApp.js";
import { HomePage } from "./product/HomePage.js";
import { AgentEditorPage } from "./product/AgentEditorPage.js";
import { ContextLabPage } from "./product/ContextLabPage.js";
import { McpPage } from "./product/McpPage.js";
import { MePage } from "./product/MePage.js";
import { ModelAdmissionPage } from "./product/ModelAdmissionPage.js";
import "./product/product.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root");

// Demo 路径不挂载真实 App，避免创建第二个 ACP connection owner。
const application = route();

function route() {
  const path = normalize(location.pathname);
  if (isDemoRoute(path)) return <DemoApp />;
  if (path === "/") return <HomePage />;
  if (path === "/session") return <App />;
  if (/^\/sessions\/[^/]+$/.test(path)) return <App />;
  if (path === "/context-lab") return <ContextLabPage />;
  if (path === "/me") return <MePage />;
  if (path === "/models/new") return <ModelAdmissionPage />;
  if (path === "/agents/new") return <AgentEditorPage />;
  const agent = path.match(/^\/agents\/([^/]+)$/)?.[1];
  if (agent) return <AgentEditorPage agentId={decodeURIComponent(agent)} />;
  if (path === "/mcp/new") return <McpPage />;
  const mcp = path.match(/^\/mcp\/([^/]+)$/)?.[1];
  if (mcp) return <McpPage mcpId={decodeURIComponent(mcp)} />;
  return <main className="product-page"><section className="product-state"><strong>页面不存在</strong><a href="/">返回首页</a></section></main>;
}

function normalize(pathname: string) { return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname; }

// 不启用开发期双挂载，确保页面只有一个明确的 ACP 连接拥有者。
createRoot(root).render(<RenderErrorBoundary scope="app">{application}</RenderErrorBoundary>);
