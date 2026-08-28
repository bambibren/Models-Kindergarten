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

/** 描述「MessageRole」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type MessageRole = "user" | "assistant";
type MessageUpdate =
  | "user_message_chunk"
  | "agent_message_chunk"
  | "agent_thought_chunk";

/** 把 ModelEvent 翻译成唯一的对外协议：ACP session/update。 */
/** 描述「AcpOutput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class AcpOutput {
  /** 初始化「AcpOutput」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly sessionId: string,
    private readonly channel: SessionAcpChannel,
  ) {}

  /** 执行「message」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

  /** 执行「thought」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async thought(
    messageId: string,
    text: string,
    meta: MessageMeta,
  ): Promise<void> {
    await this.content("agent_thought_chunk", messageId, text, meta);
  }

  /** 根据已校验输入构建「toolCall」结果，不额外持有调用方的大对象。 */
async toolCall(value: acp.ToolCall): Promise<void> {
    await this.channel.project(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(client) => client.notify(acp.methods.client.session.update, {
      sessionId: this.sessionId,
      update: { sessionUpdate: "tool_call", ...value },
    }), `tool_call/${value.toolCallId}`);
  }

  /** 根据已校验输入构建「toolUpdate」结果，不额外持有调用方的大对象。 */
async toolUpdate(value: acp.ToolCallUpdate): Promise<void> {
    await this.channel.project(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(client) => client.notify(acp.methods.client.session.update, {
      sessionId: this.sessionId,
      update: { sessionUpdate: "tool_call_update", ...value },
    }), `tool_call_update/${value.toolCallId}`);
  }

  /** 执行「contextSummary」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async contextSummary(summary: ContextSummary): Promise<void> {
    await this.channel.project(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(client) => client.notify(CONTEXT_SUMMARY_NOTIFICATION, {
      sessionId: this.sessionId,
      summary,
    }), `context_summary/${summary.turnId}`);
  }

  /** 根据已校验输入构建「tokenUsage」结果，不额外持有调用方的大对象。 */
async tokenUsage(usage: TurnTokenUsage): Promise<void> {
    await this.channel.project(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(client) => client.notify(TOKEN_USAGE_NOTIFICATION, {
      sessionId: this.sessionId,
      usage,
    }), `token_usage/${usage.turnId}`);
  }

  /** 执行「contextWindowUsage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async contextWindowUsage(state: ContextWindowUsageState): Promise<void> {
    await this.channel.project(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(client) => client.notify(CONTEXT_WINDOW_USAGE_NOTIFICATION, {
      sessionId: this.sessionId,
      state,
    }), `context_window_usage/${state.afterTurnId}`);
  }

  /** 执行「turnState」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async turnState(turn: TurnState): Promise<void> {
    await this.channel.project(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(client) => client.notify(TURN_STATE_NOTIFICATION, {
        sessionId: this.sessionId,
        turn,
      }), `turn_state/${turn.turnId}/${turn.status}`);
  }

  /** 执行「content」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async content(
    sessionUpdate: MessageUpdate,
    messageId: string,
    text: string,
    meta: MessageMeta,
  ): Promise<void> {
    await this.channel.project(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(client) => client.notify(acp.methods.client.session.update, {
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
