import { useEffect, useState, type ReactNode } from "react";
import { Loader } from "../components/primitives/Loader.js";
import { readAuthSession, type AuthSessionView } from "./auth-client.js";
import { AuthSessionProvider } from "./auth-session-context.js";

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<
    { phase: "loading" } | { phase: "ready"; session: AuthSessionView } | { phase: "error" }
  >({ phase: "loading" });

  useEffect(() => {
    let active = true;
    void readAuthSession().then((session) => {
      if (!active) return;
      if (!session) {
        const next = `${location.pathname}${location.search}${location.hash}`;
        location.replace(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      setState({ phase: "ready", session });
    }).catch(() => { if (active) setState({ phase: "error" }); });
    return () => { active = false; };
  }, []);

  if (state.phase === "ready") return <AuthSessionProvider session={state.session}>{children}</AuthSessionProvider>;
  if (state.phase === "loading") {
    return <main className="product-auth-state"><Loader size="lg" label="正在验证登录状态" /></main>;
  }
  return <main className="product-auth-state"><section><strong>无法检查登录状态</strong><button type="button" onClick={() => location.reload()}>重试</button></section></main>;
}
