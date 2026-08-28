import { Bot, GraduationCap, UserRound } from "lucide-react";

/** 渲染「ProductNav」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ProductNav({ active }: { active: "home" | "context" | "me" | "chat" | "agent" }) {
  return <header className="product-nav">
    <a className="product-brand" href="/"><span><GraduationCap size={17} /></span><div><strong>模型幼儿园</strong><small>Models KinderGarten</small></div></a>
    <nav>
      {/* 上下文实验保留实现；功能调研期间不暴露顶部导航入口。 */}
      <a className={active === "agent" ? "active" : ""} href="/agents/new"><Bot size={14} />新建 Agent</a>
      <a className={active === "me" ? "active" : ""} href="/me"><UserRound size={14} />Admin</a>
    </nav>
  </header>;
}
