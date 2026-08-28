import { createRoot } from "react-dom/client";
import App from "./App.js";
import { RenderErrorBoundary } from "./components/errors/RenderErrorBoundary.js";
import { DemoApp, isDemoRoute } from "./demo/DemoApp.js";
import { HomePage } from "./product/HomePage.js";
import { AgentEditorPage } from "./product/AgentEditorPage.js";
import { ContextLabPage } from "./product/ContextLabPage.js";
import { McpPage } from "./product/McpPage.js";
import { MePage } from "./product/MePage.js";
import { ArtifactDetailPage } from "./product/ArtifactDetailPage.js";
import { ModelAdmissionPage } from "./product/ModelAdmissionPage.js";
import "./product/product.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root");

window.addEventListener("error", /** 处理当前外部事件；注册方必须在对称生命周期中移除监听器。 */
(event) => {
  console.error("[web-runtime] uncaught error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error instanceof Error ? event.error.stack : undefined,
  });
});
window.addEventListener("unhandledrejection", /** 处理当前外部事件；注册方必须在对称生命周期中移除监听器。 */
(event) => {
  const reason = event.reason;
  console.error("[web-runtime] unhandled rejection", {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// Demo 路径不挂载真实 App，避免创建第二个 ACP connection owner。
const application = route();

/** 执行「route」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function route() {
  const path = normalize(location.pathname);
  if (isDemoRoute(path)) return <DemoApp />;
  if (path === "/") return <HomePage />;
  if (path === "/session") return <App />;
  if (/^\/sessions\/[^/]+$/.test(path)) return <App />;
  if (path === "/context-lab") return <ContextLabPage />;
  if (path === "/me") return <MePage />;
  const artifact = path.match(/^\/artifacts\/([^/]+)$/)?.[1];
  if (artifact) return <ArtifactDetailPage artifactId={decodeURIComponent(artifact)} />;
  if (path === "/models/new") return <ModelAdmissionPage />;
  if (path === "/agents/new") return <AgentEditorPage />;
  const agent = path.match(/^\/agents\/([^/]+)$/)?.[1];
  if (agent) return <AgentEditorPage agentId={decodeURIComponent(agent)} />;
  if (path === "/mcp/new") return <McpPage />;
  const mcp = path.match(/^\/mcp\/([^/]+)$/)?.[1];
  if (mcp) return <McpPage mcpId={decodeURIComponent(mcp)} />;
  return <main className="product-page"><section className="product-state"><strong>页面不存在</strong><a href="/">返回首页</a></section></main>;
}

/** 校验并规范化「normalize」输入，非法数据直接返回明确错误。 */
function normalize(pathname: string) { return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname; }

// 不启用开发期双挂载，确保页面只有一个明确的 ACP 连接拥有者。
createRoot(root).render(<RenderErrorBoundary scope="app">{application}</RenderErrorBoundary>);
