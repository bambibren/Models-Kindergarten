import { createContext, useContext, type ReactNode } from "react";
import type { AuthSessionView } from "./auth-client.js";

const AuthSessionContext = createContext<AuthSessionView | undefined>(undefined);

/** 把服务端确认的登录身份提供给受保护页面，避免各组件自行猜测或写死账号名。 */
export function AuthSessionProvider({ children, session }: { children: ReactNode; session: AuthSessionView }) {
  return <AuthSessionContext.Provider value={session}>{children}</AuthSessionContext.Provider>;
}

/** 读取当前受保护页面的登录会话；脱离 AuthGate 的独立渲染允许返回空值。 */
export function useAuthSession(): AuthSessionView | undefined {
  return useContext(AuthSessionContext);
}
