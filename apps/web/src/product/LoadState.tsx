import { AlertCircle, LoaderCircle } from "lucide-react";

/** 渲染「LoadingState」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return <div className="product-state"><LoaderCircle className="spin" size={20} /><strong>{label}</strong></div>;
}
/** 渲染「ErrorState」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ErrorState({ message, requestId, retry }: { message: string; requestId?: string; retry: () => void }) {
  return <div className="product-state error"><AlertCircle size={20} /><strong>读取失败</strong><p>{message}</p>{requestId && <code>requestId: {requestId}</code>}<button type="button" onClick={retry}>重试</button></div>;
}
