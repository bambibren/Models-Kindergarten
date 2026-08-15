import { Beaker, Bot, GraduationCap, UserRound } from "lucide-react";

export function ProductNav({ active }: { active: "home" | "context" | "me" | "chat" | "agent" }) {
  return <header className="product-nav">
    <a className="product-brand" href="/"><span><GraduationCap size={17} /></span><strong>ModelStudent</strong></a>
    <nav>
      <a className={active === "context" ? "active" : ""} href="/context-lab"><Beaker size={14} />上下文实验</a>
      <a className={active === "agent" ? "active" : ""} href="/agents/new"><Bot size={14} />新建 Agent</a>
      <a className={active === "me" ? "active" : ""} href="/me"><UserRound size={14} />Admin</a>
    </nav>
  </header>;
}
