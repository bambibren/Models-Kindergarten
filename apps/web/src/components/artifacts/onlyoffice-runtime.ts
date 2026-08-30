import type { PptxPlaybackResponse } from "@kindergarten/contracts";

export interface OnlyOfficeEditor {
  destroyEditor(): void;
}

interface OnlyOfficeWindow extends Window {
  DocsAPI?: {
    DocEditor: new (id: string, config: Record<string, unknown>) => OnlyOfficeEditor;
  };
}

interface EditorEvents {
  onDocumentReady: () => void;
  onError: () => void;
}

const scripts = new Map<string, Promise<void>>();
const preloads = new Set<string>();
const preconnects = new Set<string>();
const warmups = new Map<string, Promise<void>>();
const WARMUP_TIMEOUT_MS = 30_000;
let warmHostSequence = 0;

/** ONLYOFFICE 9+ 的预加载页与 api.js 同目录，版本路径由服务端地址自然保留。 */
export function onlyOfficePreloadUrl(apiUrl: string): string {
  const url = httpUrl(apiUrl);
  if (!url.pathname.endsWith("/api.js")) throw new Error("ONLYOFFICE API 地址必须以 /api.js 结尾");
  url.pathname = `${url.pathname.slice(0, -"api.js".length)}preload.html`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** 用户打开 PPTX 预览后才预连并加载官方隐藏预载页，不在首页制造空闲负载。 */
export function preloadOnlyOfficeStaticAssets(apiUrl: string): void {
  if (typeof document === "undefined") return;
  const api = httpUrl(apiUrl);
  const origin = api.origin;
  if (!preconnects.has(origin)) {
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = origin;
    document.head.append(link);
    preconnects.add(origin);
  }

  const preloadUrl = onlyOfficePreloadUrl(apiUrl);
  if (preloads.has(preloadUrl)) return;
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.title = "ONLYOFFICE 资源预加载";
  frame.src = preloadUrl;
  frame.setAttribute("aria-hidden", "true");
  (document.body ?? document.documentElement).append(frame);
  preloads.add(preloadUrl);
}

/** 复用同一 API 脚本加载结果；失败时删除缓存，允许用户显式重试。 */
export function loadOnlyOffice(url: string): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("ONLYOFFICE 只能在浏览器中加载"));
  }
  if ((window as OnlyOfficeWindow).DocsAPI) return Promise.resolve();
  const existing = scripts.get(url);
  if (existing) return existing;
  const promise = new Promise<void>(/** 完成异步脚本桥接，并保证失败后仍能重新加载。 */
  (resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = /** ONLYOFFICE 会在脚本完成时同步注册全局 DocsAPI。 */
    () => resolve();
    script.onerror = /** 清理失败节点，避免后续重试复用不可用的 script。 */
    () => {
      scripts.delete(url);
      script.remove();
      reject(new Error("ONLYOFFICE API 加载失败"));
    };
    document.head.append(script);
  });
  scripts.set(url, promise);
  return promise;
}

/** 文档真正可用才进入 ready；onAppReady 只代表外壳 iframe 就绪，不能结束加载态。 */
export function onlyOfficeEditorConfig(
  config: PptxPlaybackResponse["config"],
  events: EditorEvents,
): PptxPlaybackResponse["config"] & {
  width: string;
  height: string;
  events: EditorEvents;
} {
  return {
    ...config,
    width: "100%",
    height: "100%",
    events: {
      onDocumentReady: events.onDocumentReady,
      onError: events.onError,
    },
  };
}

/** 在脚本加载完成后用统一配置创建编辑器，避免可见播放器与 Warmup 漂移。 */
export function createOnlyOfficeEditor(
  hostId: string,
  config: PptxPlaybackResponse["config"],
  events: EditorEvents,
  size: { width: string; height: string } = { width: "100%", height: "100%" },
): OnlyOfficeEditor {
  if (typeof window === "undefined") throw new Error("ONLYOFFICE 只能在浏览器中加载");
  const DocsAPI = (window as OnlyOfficeWindow).DocsAPI;
  if (!DocsAPI) throw new Error("ONLYOFFICE API 未加载");
  return new DocsAPI.DocEditor(hostId, { ...onlyOfficeEditorConfig(config, events), ...size });
}

/** 用稳定 document key 做一次有界后台转换；成功后可见播放器直接命中 DocumentServer 缓存。 */
export function warmOnlyOfficePlayback(value: PptxPlaybackResponse): Promise<void> {
  preloadOnlyOfficeStaticAssets(value.documentServerApiUrl);
  const warmKey = onlyOfficeWarmupKey(value);
  const existing = warmups.get(warmKey);
  if (existing) return existing;
  const warmup = performWarmup(value).catch(/** 失败不污染永久缓存，下一次显式播放仍可走正常冷启动。 */
  (error: unknown) => {
    warmups.delete(warmKey);
    throw error;
  });
  warmups.set(warmKey, warmup);
  return warmup;
}

/** 当前浏览器页面按 DocumentServer 与稳定文档版本去重；刷新页面或 document key 变化后重新预热。 */
export function onlyOfficeWarmupKey(value: PptxPlaybackResponse): string {
  return `${httpUrl(value.documentServerApiUrl).origin}\0${value.config.document.key}`;
}

/** 创建不可见编辑器并在 document ready、错误或超时后完整释放浏览器资源。 */
async function performWarmup(value: PptxPlaybackResponse): Promise<void> {
  await loadOnlyOffice(value.documentServerApiUrl);

  const host = document.createElement("div");
  host.id = `onlyoffice-warm-${++warmHostSequence}`;
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    top: "0",
    left: "-10000px",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.append(host);

  return new Promise<void>(/** 将 ONLYOFFICE 事件收敛成一次性的有界 Warmup。 */
  (resolve, reject) => {
    let editor: OnlyOfficeEditor | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      try { editor?.destroyEditor(); }
      catch { /* Warmup 已完成，销毁异常不能改变缓存事实。 */ }
      host.remove();
      document.getElementById(host.id)?.remove();
      if (error) reject(error);
      else resolve();
    };
    const timeout = globalThis.setTimeout(/** 3.9 GB 主机上禁止隐藏编辑器无限占用资源。 */
    () => finish(new Error("ONLYOFFICE 后台预热超时")), WARMUP_TIMEOUT_MS);
    try {
      editor = createOnlyOfficeEditor(host.id, value.config, {
        onDocumentReady: () => finish(),
        onError: () => finish(new Error("ONLYOFFICE 后台预热失败")),
      }, { width: "1px", height: "1px" });
      if (settled) editor.destroyEditor();
    } catch (error) {
      finish(error instanceof Error ? error : new Error("ONLYOFFICE 后台预热失败"));
    }
  });
}

/** 只接受明确的 HTTP(S) 服务地址，避免预加载节点获得脚本型 URL。 */
function httpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("ONLYOFFICE URL 必须使用 HTTP(S)");
  return url;
}
