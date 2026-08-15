import type { ContentBlock } from "@agentclientprotocol/sdk";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";

export function ContentRenderer({ content, streaming = false }: { content: ContentBlock[]; streaming?: boolean }) {
  return <div className="content-blocks">
    {content.map((item, index) => {
      if (item.type === "text") return <Streamdown key={index} animated={streaming} isAnimating={streaming} plugins={{ cjk }}>{item.text}</Streamdown>;
      if (item.type === "image") return <img alt="消息图片" key={index} src={`data:${item.mimeType};base64,${item.data}`} />;
      if (item.type === "audio") return <audio controls key={index} src={`data:${item.mimeType};base64,${item.data}`} />;
      if (item.type === "resource_link") return <a href={item.uri} key={index} onClick={(event) => {
        if (!item.uri.startsWith("mk-file://")) return;
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("mk-open-file-reference", { detail: item.uri.slice("mk-file://".length) }));
      }} rel="noreferrer" target="_blank">{item.title ?? item.name}</a>;
      return <details key={index}><summary>{item.resource.uri}</summary><pre>{"text" in item.resource ? item.resource.text : "二进制资源"}</pre></details>;
    })}
  </div>;
}
