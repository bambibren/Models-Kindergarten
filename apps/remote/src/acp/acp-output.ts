import * as acp from "@agentclientprotocol/sdk";
import {
  CONTEXT_SUMMARY_NOTIFICATION,
  CONTEXT_WINDOW_USAGE_NOTIFICATION,
  TOKEN_USAGE_NOTIFICATION,
  TURN_STATE_NOTIFICATION,
  makeAcpMeta,
  type ContextSummary,
  type ContextWindowUsageState,
  type MessageMeta,
  type TurnTokenUsage,
  type TurnState,
} from "@kindergarten/contracts";
import { SessionAcpChannel } from "./session-acp-channel.js";

export type MessageRole = "user" | "assistant";
type MessageUpdate =
  | "user_message_chunk"
  | "agent_message_chunk"
  | "agent_thought_chunk";

/** 把 ModelEvent 翻译成唯一的对外协议：ACP session/update。 */
export class AcpOutput {
  constructor(
    private readonly sessionId: string,
    private readonly channel: SessionAcpChannel,
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
    await this.channel.project((client) => client.notify(acp.methods.client.session.update, {
      sessionId: this.sessionId,
      update: { sessionUpdate: "tool_call", ...value },
    }), `tool_call/${value.toolCallId}`);
  }

  async toolUpdate(value: acp.ToolCallUpdate): Promise<void> {
    await this.channel.project((client) => client.notify(acp.methods.client.session.update, {
      sessionId: this.sessionId,
      update: { sessionUpdate: "tool_call_update", ...value },
    }), `tool_call_update/${value.toolCallId}`);
  }

  async contextSummary(summary: ContextSummary): Promise<void> {
    await this.channel.project((client) => client.notify(CONTEXT_SUMMARY_NOTIFICATION, {
      sessionId: this.sessionId,
      summary,
    }), `context_summary/${summary.turnId}`);
  }

  async tokenUsage(usage: TurnTokenUsage): Promise<void> {
    await this.channel.project((client) => client.notify(TOKEN_USAGE_NOTIFICATION, {
      sessionId: this.sessionId,
      usage,
    }), `token_usage/${usage.turnId}`);
  }

  async contextWindowUsage(state: ContextWindowUsageState): Promise<void> {
    await this.channel.project((client) => client.notify(CONTEXT_WINDOW_USAGE_NOTIFICATION, {
      sessionId: this.sessionId,
      state,
    }), `context_window_usage/${state.afterTurnId}`);
  }

  async turnState(turn: TurnState): Promise<void> {
    await this.channel.project((client) => client.notify(TURN_STATE_NOTIFICATION, {
        sessionId: this.sessionId,
        turn,
      }), `turn_state/${turn.turnId}/${turn.status}`);
  }

  private async content(
    sessionUpdate: MessageUpdate,
    messageId: string,
    text: string,
    meta: MessageMeta,
  ): Promise<void> {
    await this.channel.project((client) => client.notify(acp.methods.client.session.update, {
      sessionId: this.sessionId,
      update: {
        sessionUpdate,
        content: { type: "text", text },
        messageId,
        _meta: makeAcpMeta(meta),
      },
    }), `${sessionUpdate}/${messageId}`);
  }

}
