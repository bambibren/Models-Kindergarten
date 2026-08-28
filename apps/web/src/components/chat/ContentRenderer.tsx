import type { ContentBlock } from "@agentclientprotocol/sdk";
import { parseArtifactUri } from "@kindergarten/contracts";
import { Streamdown, defaultUrlTransform } from "streamdown";
import type { Components } from "streamdown";
import { cjk } from "@streamdown/cjk";
import type { ReactNode } from "react";

const ARTIFACT_FRAGMENT = "#mk-artifact=";
const OPAQUE_ID = /^[A-Za-z0-9_-]{8,160}$/;
const INTERNAL_TAGS = { "mk-artifact": ["artifact_id"] };
const INTERNAL_COMPONENTS: Components = {
  "mk-artifact": InternalArtifactLink,
};

/** 渲染「ContentRenderer」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ContentRenderer({ content, streaming = false }: { content: ContentBlock[]; streaming?: boolean }) {
  return <div className="content-blocks">
    {content.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item, index) => {
      if (item.type === "text") return <Streamdown
        allowedTags={INTERNAL_TAGS}
        animated={streaming}
        components={INTERNAL_COMPONENTS}
        isAnimating={streaming}
        key={index}
        literalTagContent={["mk-artifact"]}
        plugins={{ cjk }}
        urlTransform={messageUrlTransform}
      >{rewriteInternalMarkdownLinks(item.text)}</Streamdown>;
      if (item.type === "image") return <img alt="消息图片" key={index} src={`data:${item.mimeType};base64,${item.data}`} />;
      if (item.type === "audio") return <audio controls key={index} src={`data:${item.mimeType};base64,${item.data}`} />;
      if (item.type === "resource_link" && item.uri.startsWith("mk-file://")) {
        return <span key={index}>{item.title ?? item.name}</span>;
      }
      if (item.type === "resource_link") return <a href={item.uri} key={index} onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
(event) => {
        if (!item.uri.startsWith("artifact://")) return;
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("mk-open-artifact", { detail: item.uri.slice("artifact://".length) }));
      }} rel="noreferrer" target="_blank">{item.title ?? item.name}</a>;
      return <details key={index}><summary>{item.resource.uri}</summary><pre>{"text" in item.resource ? item.resource.text : "二进制资源"}</pre></details>;
    })}
  </div>;
}

/** Streamdown 只接收浏览器安全链接；内部协议改写为本页 fragment，再由容器打开预览。 */
export const messageUrlTransform: typeof defaultUrlTransform = /** 执行「messageUrlTransform」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(url, key, node) => {
  const artifactId = parseArtifactUri(url);
  if (artifactId) return `${ARTIFACT_FRAGMENT}${encodeURIComponent(artifactId)}`;
  return defaultUrlTransform(url, key, node);
};

/** 执行「rewriteInternalMarkdownLinks」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function rewriteInternalMarkdownLinks(markdown: string): string {
  return markdown
    .replace(/\[([^\]\n]+)\]\(artifact:\/\/([A-Za-z0-9_-]{8,160})\)/g, /** 执行「replace」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(_match, label: string, id: string) =>
      `<mk-artifact artifact_id="${id}">${escapeTagText(label)}</mk-artifact>`)
    .replace(/\[([^\]\n]+)\]\(mk-file:\/\/[A-Za-z0-9_-]{8,160}\)/g, "$1");
}

/** 渲染「InternalArtifactLink」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function InternalArtifactLink(props: Record<string, unknown>): ReactNode {
  return <InternalLink id={props.artifact_id}>{props.children as ReactNode}</InternalLink>;
}

/** 渲染「InternalLink」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function InternalLink({ children, id }: { children: ReactNode; id: unknown }) {
  if (typeof id !== "string" || !OPAQUE_ID.test(id)) return <span>{children}</span>;
  return <button className="markdown-internal-link" type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => window.dispatchEvent(new CustomEvent(
    "mk-open-artifact",
    { detail: id },
  ))}>{children}</button>;
}

/** 执行「escapeTagText」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function escapeTagText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
