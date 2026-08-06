import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root");

// 不启用开发期双挂载，确保页面只有一个明确的 ACP 连接拥有者。
createRoot(root).render(<App />);

