import { useState } from "react";
import { Bot, GraduationCap, LogOut, UserRound } from "lucide-react";
import { logout } from "./auth-client.js";

/** 先撤销服务端会话，再离开当前页面，避免退出失败时误导用户。 */
export async function performLogout(
  request: () => Promise<void> = logout,
  navigate: (path: string) => void = (path) => location.assign(path),
): Promise<void> {
  await request();
  navigate("/login");
}

/** 渲染「ProductNav」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ProductNav({ active }: { active: "home" | "context" | "me" | "chat" | "agent" }) {
  const [logoutState, setLogoutState] = useState<"idle" | "pending" | "failed">("idle");

  /** 单次执行退出流程；失败时保留当前页面并允许用户重试。 */
  const onLogout = async () => {
    if (logoutState === "pending") return;
    setLogoutState("pending");
    try { await performLogout(); }
    catch { setLogoutState("failed"); }
  };

  return <header className="product-nav">
    <a className="product-brand" href="/"><span><GraduationCap size={17} /></span><div><strong>模型幼儿园</strong><small>Models KinderGarten</small></div></a>
    <nav>
      {/* 上下文实验保留实现；功能调研期间不暴露顶部导航入口。 */}
      <a className={active === "agent" ? "active" : ""} href="/agents/new"><Bot size={14} />新建 Agent</a>
      <div className="product-account">
        <a aria-label="打开个人空间" className={`product-account-trigger ${active === "me" ? "active" : ""}`} href="/me"><UserRound size={14} /><span>Admin</span></a>
        <div className="product-account-menu">
          <button aria-label="退出登录" disabled={logoutState === "pending"} type="button" onClick={() => void onLogout()}>
            <LogOut size={14} />
            {logoutState === "pending" ? "正在退出" : logoutState === "failed" ? "退出失败，请重试" : "退出登录"}
          </button>
        </div>
      </div>
    </nav>
  </header>;
}
