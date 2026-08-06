import * as acp from "@agentclientprotocol/sdk";
import { makeAcpMeta, type MessageMeta } from "@kindergarten/contracts";

export type MessageRole = "user" | "assistant";
type MessageUpdate =
  | "user_message_chunk"
  | "agent_message_chunk"
  | "agent_thought_chunk";

/** 把 ModelEvent 翻译成唯一的对外协议：ACP session/update。 */
export class AcpOutput {
  constructor(
    private readonly sessionId: string,
    private readonly client: acp.AgentContext,
  ) {}

  async message(
    role: MessageRole,
    messageId: string,
    text: string,
    meta: MessageMeta,
  ): Promise<void> {
    await this.content(
      role === "user" ? "user_message_chunk" : "agent_message_chunk",
      messageId,
      text,
      meta,
    );
  }

  async thought(
    messageId: string,
    text: string,
    meta: MessageMeta,
  ): Promise<void> {
    await this.content("agent_thought_chunk", messageId, text, meta);
  }

  async toolCall(value: acp.ToolCall): Promise<void> {
    await this.client.notify(acp.methods.client.session.update, {
      sessionId: this.sessionId,
      update: { sessionUpdate: "tool_call", ...value },
    });
  }

  async toolUpdate(value: acp.ToolCallUpdate): Promise<void> {
    await this.client.notify(acp.methods.client.session.update, {
      sessionId: this.sessionId,
      update: { sessionUpdate: "tool_call_update", ...value },
    });
  }

  private async content(
    sessionUpdate: MessageUpdate,
    messageId: string,
    text: string,
    meta: MessageMeta,
  ): Promise<void> {
    await this.client.notify(acp.methods.client.session.update, {
      sessionId: this.sessionId,
      update: {
        sessionUpdate,
        content: { type: "text", text },
        messageId,
        _meta: makeAcpMeta(meta),
      },
    });
  }
}
