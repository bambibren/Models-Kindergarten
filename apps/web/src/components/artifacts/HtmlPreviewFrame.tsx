export function HtmlPreviewFrame({ html, csp, title }: { html: string; csp?: string; title: string }) {
  return <iframe
    referrerPolicy="no-referrer"
    srcDoc={buildHtmlPreviewDocument(html, csp)}
    title={title}
  />;
}

export function buildHtmlPreviewDocument(html: string, csp?: string): string {
  const policy = csp
    ? `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`
    : "";
  const prefix = `${policy}${SAME_DOCUMENT_NAVIGATION_BRIDGE}`;
  const head = /<head(?:\s[^>]*)?>/i;

  return head.test(html) ? html.replace(head, (opening) => `${opening}${prefix}`) : `${prefix}${html}`;
}

// 与 JoyCode 的预览导航桥一致：捕获当前文档锚点，阻止默认行为和内联 onclick，再由桥接层完成滚动。
const SAME_DOCUMENT_NAVIGATION_BRIDGE = `<script data-models-kindergarten-preview-navigation>
(() => {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const source = event.target;
    const anchor = source instanceof Element ? source.closest("a[href]") : null;
    if (!anchor || (anchor.target && anchor.target !== "_self")) return;

    const href = anchor.getAttribute("href");
    if (!href || !href.startsWith("#")) return;

    let id;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      return;
    }
    const target = id
      ? document.getElementById(id) || document.getElementsByName(id)[0]
      : document.documentElement;
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const top = id ? target.getBoundingClientRect().top + window.scrollY : 0;
    const behavior = getComputedStyle(document.documentElement).scrollBehavior === "smooth" ? "smooth" : "auto";
    window.scrollTo({ top, behavior });
  }, true);
})();
</script>`;

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
