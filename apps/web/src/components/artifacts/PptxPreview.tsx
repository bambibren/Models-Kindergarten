import type { PptxPlaybackResponse } from "@kindergarten/contracts";
import { FileText, Play, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OnlyOfficePptxPlayer } from "./OnlyOfficePptxPlayer.js";
import "./PptxPreview.css";

type PreviewState =
  | { phase: "loading" }
  | { phase: "ready"; slideCount: number }
  | { phase: "error" };

export function PptxPreview({
  contentUrl,
  title,
  loadPlayback,
}: {
  contentUrl: string;
  title: string;
  loadPlayback?: () => Promise<PptxPlaybackResponse>;
}) {
  const [animated, setAnimated] = useState(false);
  if (animated && loadPlayback) {
    return <OnlyOfficePptxPlayer load={loadPlayback} title={title} onBack={() => setAnimated(false)} />;
  }
  return <StaticPptxPreview contentUrl={contentUrl} title={title} onPlay={loadPlayback ? () => setAnimated(true) : undefined} />;
}

function StaticPptxPreview({ contentUrl, title, onPlay }: { contentUrl: string; title: string; onPlay: (() => void) | undefined }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>({ phase: "loading" });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const controller = new AbortController();
    let active = true;
    let destroy: (() => void) | undefined;
    setState({ phase: "loading" });
    host.replaceChildren();

    void (async () => {
      try {
        const [{ PptxViewer, RECOMMENDED_ZIP_LIMITS }, response] = await Promise.all([
          import("@aiden0z/pptx-renderer/browser"),
          fetch(contentUrl, { signal: controller.signal }),
        ]);
        if (!response.ok) throw new Error(`PPTX 下载失败：HTTP ${response.status}`);
        const viewer = await PptxViewer.open(await response.arrayBuffer(), host, {
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          lazySlides: true,
          lazyMedia: true,
          pdfjs: false,
          scrollContainer: host,
          listOptions: { windowed: true, initialSlides: 4, batchSize: 4, showSlideLabels: true },
          signal: controller.signal,
        });
        destroy = () => viewer.destroy();
        if (!active) {
          destroy();
          return;
        }
        setState({ phase: "ready", slideCount: viewer.slideCount });
      } catch (error) {
        if (active && !controller.signal.aborted) setState({ phase: "error" });
      }
    })();

    return () => {
      active = false;
      controller.abort();
      destroy?.();
      host.replaceChildren();
    };
  }, [attempt, contentUrl]);

  return <section aria-busy={state.phase === "loading"} aria-label={`${title} PPTX 预览`} className="pptx-preview">
    <div className="pptx-preview__status">
      <span role="status">{state.phase === "loading" ? "正在解析 PPTX…" : state.phase === "ready" ? `共 ${state.slideCount} 页` : "PPTX 预览失败"}</span>
      {onPlay ? <button type="button" onClick={onPlay}><Play size={12} fill="currentColor" />动画播放</button> : null}
    </div>
    <div className="pptx-preview__viewport" ref={hostRef} />
    {state.phase === "error" ? <div className="pptx-preview__error">
      <FileText size={22} />
      <strong>无法在浏览器中显示这份 PPTX</strong>
      <span>可以重试预览，或使用顶部下载按钮在 PowerPoint 中打开。</span>
      <button type="button" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={14} />重试</button>
    </div> : null}
  </section>;
}
