import { useEffect, useState, type ReactNode } from "react";
import { readAuthSession } from "./auth-client.js";

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;
    void readAuthSession().then((session) => {
      if (!active) return;
      if (!session) {
        const next = `${location.pathname}${location.search}${location.hash}`;
        location.replace(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      setState("ready");
    }).catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, []);

  if (state === "ready") return <>{children}</>;
  return <main className="product-auth-state"><section><strong>{state === "error" ? "无法检查登录状态" : "正在验证登录状态"}</strong>{state === "error" && <button type="button" onClick={() => location.reload()}>重试</button>}</section></main>;
}
