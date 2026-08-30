import { useEffect, useState, type ReactNode } from "react";
import { Loader } from "../components/primitives/Loader.js";
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
  if (state === "loading") {
    return <main className="product-auth-state"><Loader size="lg" label="正在验证登录状态" /></main>;
  }
  return <main className="product-auth-state"><section><strong>无法检查登录状态</strong><button type="button" onClick={() => location.reload()}>重试</button></section></main>;
}
