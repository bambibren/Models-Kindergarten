import type { PptxPlaybackResponse } from "@kindergarten/contracts";
import { ArrowLeft, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

interface OnlyOfficeEditor {
  destroyEditor(): void;
}

interface OnlyOfficeWindow extends Window {
  DocsAPI?: {
    DocEditor: new (id: string, config: Record<string, unknown>) => OnlyOfficeEditor;
  };
}

const scripts = new Map<string, Promise<void>>();

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

  useEffect(() => {
    let active = true;
    let editor: OnlyOfficeEditor | undefined;
    setState("loading");
    void (async () => {
      try {
        const value = await load();
        await loadOnlyOffice(value.documentServerApiUrl);
        if (!active) return;
        const DocsAPI = (window as OnlyOfficeWindow).DocsAPI;
        if (!DocsAPI) throw new Error("ONLYOFFICE API 未加载");
        editor = new DocsAPI.DocEditor(hostId, {
          ...value.config,
          width: "100%",
          height: "100%",
          events: {
            onAppReady: () => { if (active) setState("ready"); },
            onError: () => { if (active) setState("error"); },
          },
        });
      } catch {
        if (active) setState("error");
      }
    })();
    return () => {
      active = false;
      editor?.destroyEditor();
    };
  }, [attempt, hostId, load]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

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
      <button type="button" onClick={() => void toggleFullscreen()}>
        {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        {fullscreen ? "退出全屏" : "全屏"}
      </button>
    </header>
    <div className="pptx-player__host" id={hostId} />
    {state === "loading" ? <div className="pptx-player__state">正在启动动画播放器…</div> : null}
    {state === "error" ? <div className="pptx-player__state pptx-player__state--error">
      <strong>动画播放器暂时不可用</strong>
      <span>请确认本机 ONLYOFFICE DocumentServer 已启动。</span>
      <button type="button" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={14} />重试</button>
    </div> : null}
  </section>;
}

function loadOnlyOffice(url: string): Promise<void> {
  if ((window as OnlyOfficeWindow).DocsAPI) return Promise.resolve();
  const existing = scripts.get(url);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scripts.delete(url);
      script.remove();
      reject(new Error("ONLYOFFICE API 加载失败"));
    };
    document.head.append(script);
  });
  scripts.set(url, promise);
  return promise;
}
