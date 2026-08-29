/** 浏览器默认只访问当前站点；开发期由 Vite、部署后由同源入口转发。 */
export const CONTROL_API_URL = import.meta.env.VITE_CONTROL_API_URL ?? "/api/control/v1";
export const EVALUATION_API_URL = import.meta.env.VITE_EVALUATION_API_URL ?? "/api/evaluation/v1";

/** 把当前页面的 HTTP(S) 来源转换为对应的 ACP WebSocket 地址。 */
export function acpWebSocketUrl(): string {
  const configured = import.meta.env.VITE_ACP_URL;
  if (configured) return configured;
  const url = new URL("/acp", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
