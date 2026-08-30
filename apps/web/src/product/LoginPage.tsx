import { useState, type FormEvent } from "react";
import { KeyRound, LogIn, UserRound } from "lucide-react";
import { login, safeNextPath } from "./auth-client.js";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(username, password);
      location.replace(safeNextPath(location.search));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "用户名或密码错误");
    } finally {
      setBusy(false);
    }
  }

  return <main className="product-login-page">
    <section className="product-login-card">
      <header><span>MK</span><div><small>MODELS KINDERGARTEN</small><h1>登录模型幼儿园</h1><p>输入服务器管理员为你创建的账号和密码。</p></div></header>
      <form onSubmit={submit}>
        <label htmlFor="login-username"><span>用户名</span><div><UserRound size={17} /><input id="login-username" autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></div></label>
        <label htmlFor="login-password"><span>密码</span><div><KeyRound size={17} /><input id="login-password" autoComplete="current-password" required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></div></label>
        {error && <p className="product-login-error" role="alert">{error}</p>}
        <button disabled={busy} type="submit"><LogIn size={17} />{busy ? "正在登录" : "登录"}</button>
      </form>
      <footer>账号只能由服务器 SSH 管理，不提供在线注册。</footer>
    </section>
  </main>;
}
