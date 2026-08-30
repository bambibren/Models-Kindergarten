import { PRODUCT_CONFIG, type PptxPlaybackResponse } from "@kindergarten/contracts";
import { Download, FileText, Play, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OnlyOfficePptxPlayer } from "./OnlyOfficePptxPlayer.js";
import "./PptxPreview.css";

type PreviewState =
  | { phase: "loading" }
  | { phase: "ready"; slideCount: number }
  | { phase: "error" };

/** 渲染「PptxPreview」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function PptxPreview({
  contentUrl,
  byteLength,
  title,
  loadPlayback,
}: {
  contentUrl: string;
  byteLength: number;
  title: string;
  loadPlayback?: () => Promise<PptxPlaybackResponse>;
}) {
  const [animated, setAnimated] = useState(false);
  if (animated && loadPlayback) {
    return <OnlyOfficePptxPlayer load={loadPlayback} title={title} onBack={/** 处理「onBack」事件，校验归属后再推进状态且避免重复提交。 */
() => setAnimated(false)} />;
  }
  return <StaticPptxPreview
    byteLength={byteLength}
    contentUrl={contentUrl}
    title={title}
    onPlay={loadPlayback ? /** 处理「onPlay」事件，校验归属后再推进状态且避免重复提交。 */
() => setAnimated(true) : undefined}
  />;
}

/** 渲染「StaticPptxPreview」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function StaticPptxPreview({ contentUrl, byteLength, title, onPlay }: {
  contentUrl: string;
  byteLength: number;
  title: string;
  onPlay: (() => void) | undefined;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>({ phase: "loading" });

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    const host = hostRef.current;
    if (!host) return;
    if (!shouldUseStaticPptxPreview(byteLength)) {
      host.replaceChildren();
      return;
    }
    const controller = new AbortController();
    let active = true;
    let destroy: (() => void) | undefined;
    setState({ phase: "loading" });
    host.replaceChildren();

    void (/** 完成当前异步桥接，并保证每条分支只结算一次。 */
async () => {
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
        destroy = /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => viewer.destroy();
        if (!active) {
          destroy();
          return;
        }
        setState({ phase: "ready", slideCount: viewer.slideCount });
      } catch (error) {
        if (active && !controller.signal.aborted) {
          console.error("PPTX 静态预览失败", error);
          setState({ phase: "error" });
        }
      }
    })();

    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => {
      active = false;
      controller.abort();
      destroy?.();
      host?.replaceChildren();
    };
  }, [attempt, byteLength, contentUrl]);

  const tooLarge = !shouldUseStaticPptxPreview(byteLength);

  return <section aria-busy={!tooLarge && state.phase === "loading"} aria-label={`${title} PPTX 预览`} className="pptx-preview">
    <div className="pptx-preview__status">
      <span role="status">{tooLarge ? "文件超过浏览器预览上限" : state.phase === "loading" ? "正在解析 PPTX…" : state.phase === "ready" ? `共 ${state.slideCount} 页` : "PPTX 预览失败"}</span>
      {onPlay ? <button type="button" onClick={onPlay}><Play size={12} fill="currentColor" />动画播放</button> : null}
    </div>
    <div className="pptx-preview__viewport" ref={hostRef} />
    {tooLarge ? <div className="pptx-preview__error">
      <FileText size={22} />
      <strong>这份 PPTX 不在浏览器内解析</strong>
      <span>文件大于 32 MiB。请下载后用 PowerPoint 打开{onPlay ? "，或使用动画播放" : ""}。</span>
      <a href={contentUrl} download><Download size={14} />下载 PPTX</a>
    </div> : state.phase === "error" ? <div className="pptx-preview__error">
      <FileText size={22} />
      <strong>无法在浏览器中显示这份 PPTX</strong>
      <span>可以重试预览，或使用顶部下载按钮在 PowerPoint 中打开。</span>
      <button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setAttempt(/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
(value) => value + 1)}><RefreshCw size={14} />重试</button>
    </div> : null}
  </section>;
}

/** 浏览器渲染器需要整体读取 PPTX ZIP，因此用字节上限阻止大文件进入堆。 */
export function shouldUseStaticPptxPreview(byteLength: number): boolean {
  return Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= PRODUCT_CONFIG.pptx.maxBrowserPreviewBytes;
}
