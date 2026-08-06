import * as Collapsible from "@radix-ui/react-collapsible";
import { Brain, ChevronDown, LoaderCircle } from "lucide-react";
import type { ThoughtEntry } from "../../chat/chat-types.js";
import { useAutoDisclosure } from "../../hooks/use-auto-disclosure.js";
import { ContentRenderer } from "../chat/ContentRenderer.js";

export function ReasoningItem({ entry }: { entry: ThoughtEntry }) {
  const active = entry.status === "streaming";
  const disclosure = useAutoDisclosure(active ? "active" : "completed");
  return <Collapsible.Root className="activity-item reasoning-item" open={disclosure.open} onOpenChange={disclosure.setOpen}>
    <Collapsible.Trigger className="activity-trigger">
      <span className="activity-icon">{active ? <LoaderCircle className="spin" size={15} /> : <Brain size={15} />}</span>
      <span className="activity-title">{active ? "正在思考" : "已思考"}</span>
      <ChevronDown className="disclosure-chevron" size={15} />
    </Collapsible.Trigger>
    <Collapsible.Content className="activity-content reasoning-content"><ContentRenderer content={entry.content} streaming={active} /></Collapsible.Content>
  </Collapsible.Root>;
}
