import { FlaskConical, GraduationCap, UserRound } from "lucide-react";
import { useState } from "react";

export function DemoTopNav({ active, compactHome = false }: { active: "home" | "context" | "me" | "session"; compactHome?: boolean }) {
  const [notice, setNotice] = useState(false);
  return <>
    <header className={`mk-demo-topnav ${compactHome ? "compact-home" : ""}`}>
      <a className="mk-demo-brand" href="/demo/model-home">
        <span><GraduationCap size={17} /></span>
        <strong>ModelStudent</strong>
      </a>
      <div className="mk-demo-account-actions">
        <a className={active === "me" ? "active" : ""} href="/demo/me?tab=experiments"><UserRound size={14} />Admin</a>
      </div>
    </header>
    {notice && <div className="mk-demo-inline-notice" role="status">
      模型入学将在后续版本开放；当前页面只展示固定 ModelStudent。
      <button type="button" onClick={() => setNotice(false)}>知道了</button>
    </div>}
  </>;
}
