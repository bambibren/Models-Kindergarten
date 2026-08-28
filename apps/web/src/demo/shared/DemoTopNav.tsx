import { GraduationCap, UserRound } from "lucide-react";
import { useState } from "react";

/** 渲染「DemoTopNav」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function DemoTopNav({ active, compactHome = false }: { active: "home" | "context" | "me" | "session"; compactHome?: boolean }) {
  const [notice, setNotice] = useState(false);
  return <>
    <header className={`mk-demo-topnav ${compactHome ? "compact-home" : ""}`}>
      <a className="mk-demo-brand" href="/demo/model-home">
        <span><GraduationCap size={17} /></span>
        <strong>ModelStudent</strong>
      </a>
      <div className="mk-demo-account-actions">
        <a className={active === "me" ? "active" : ""} href="/demo/me?tab=agents"><UserRound size={14} />Admin</a>
      </div>
    </header>
    {notice && <div className="mk-demo-inline-notice" role="status">
      模型入学将在后续版本开放；当前页面只展示固定 ModelStudent。
      <button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setNotice(false)}>知道了</button>
    </div>}
  </>;
}
