import type { PptxPlaybackResponse } from "@kindergarten/contracts";
import { ArrowLeft, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  createOnlyOfficeEditor,
  loadOnlyOffice,
  type OnlyOfficeEditor,
} from "./onlyoffice-runtime.js";

/** 渲染「OnlyOfficePptxPlayer」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function OnlyOfficePptxPlayer({
  load,
  title,
  onBack,
}: {
  load: () => Promise<PptxPlaybackResponse>;
  title: string;
  onBack: () => void;
}) {
  const frameRef = useRef<HTMLElement>(null);
  const hostId = `onlyoffice-${useId().replaceAll(":", "")}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    let active = true;
    let editor: OnlyOfficeEditor | undefined;
    setState("loading");
    void (/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
async () => {
      try {
        const value = await load();
        await loadOnlyOffice(value.documentServerApiUrl);
        if (!active) return;
        editor = createOnlyOfficeEditor(hostId, value.config, {
          onDocumentReady: /** 文档内容与播放器均可用后才移除加载遮罩。 */
() => { if (active) setState("ready"); },
          onError: /** 处理「onError」事件，校验归属后再推进状态且避免重复提交。 */
() => { if (active) setState("error"); },
        });
      } catch {
        if (active) setState("error");
      }
    })();
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => {
      active = false;
      editor?.destroyEditor();
    };
  }, [attempt, hostId, load]);

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    const handleFullscreenChange = /** 处理「handleFullscreenChange」事件，校验归属后再推进状态且避免重复提交。 */
() => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  /** 根据已校验输入构建「toggleFullscreen」结果，不额外持有调用方的大对象。 */
async function toggleFullscreen() {
    const frame = frameRef.current;
    if (!frame) return;
    if (fullscreen) {
      if (document.fullscreenElement === frame && typeof document.exitFullscreen === "function") {
        try { await document.exitFullscreen(); }
        catch { /* 浏览器拒绝退出原生全屏时，仍退出页面内全屏。 */ }
      }
      setFullscreen(false);
      return;
    }

    // 应用内浏览器未实现 Fullscreen API，先进入页面内全屏，再尽力升级为原生全屏。
    setFullscreen(true);
    if (typeof frame.requestFullscreen === "function") {
      try { await frame.requestFullscreen(); }
      catch { /* 页面内全屏继续可用。 */ }
    }
  }

  return <section
    aria-busy={state === "loading"}
    aria-label={`${title} 动画播放`}
    className={`pptx-player${fullscreen ? " pptx-player--fullscreen" : ""}`}
    ref={frameRef}
  >
    <header className="pptx-player__toolbar">
      <button type="button" onClick={onBack}><ArrowLeft size={14} />静态预览</button>
      <strong>{title}</strong>
      <button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => void toggleFullscreen()}>
        {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        {fullscreen ? "退出全屏" : "全屏"}
      </button>
    </header>
    <div className="pptx-player__host" id={hostId} />
    {state === "loading" ? <div className="pptx-player__state">正在启动动画播放器…</div> : null}
    {state === "error" ? <div className="pptx-player__state pptx-player__state--error">
      <strong>动画播放器暂时不可用</strong>
      <span>请确认本机 ONLYOFFICE DocumentServer 已启动。</span>
      <button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setAttempt(/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
(value) => value + 1)}><RefreshCw size={14} />重试</button>
    </div> : null}
  </section>;
}
