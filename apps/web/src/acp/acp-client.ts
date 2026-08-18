import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import {
  CONTEXT_SUMMARY_NOTIFICATION,
  TOKEN_USAGE_NOTIFICATION,
  TURN_STATE_NOTIFICATION,
  makeExperimentRunRefMeta,
  makeTurnInteractionId,
  makePromptMeta,
  makeSessionResumeMeta,
  makeSessionBindingMeta,
  readContextSummaryNotification,
  readTokenUsageNotification,
  readTurnStateNotification,
  type ContextSummaryNotification,
  type TokenUsageNotification,
  type TurnStateNotification,
  type SessionResumeMeta,
  type ArtifactMentionInput,
} from "@kindergarten/contracts";
import type { PendingInteractionState } from "../prompt-turn/prompt-turn-types.js";

export interface PromptIds {
  turnId: string;
  operationId?: string;
  artifactMentions?: ArtifactMentionInput[];
}

export interface ClientHandlers {
  onUpdate: (value: acp.SessionNotification) => void;
  onContextSummary: (value: ContextSummaryNotification) => void;
  onTokenUsage: (value: TokenUsageNotification) => void;
  onTurnState: (value: TurnStateNotification) => void;
  onInteraction: (value: PendingInteractionState) => void;
  onInteractionResolved: (id: string) => void;
  onClose: () => void;
}

/**
 * 浏览器只有一个 ACP 连接拥有者。
 * 这里不做自动重试，避免旧系统中“连接恢复”和“历史回放”互相触发。
 */
export class AcpWebClient {
  private constructor(
    private readonly connection: acp.ClientConnection,
    private readonly interactions: PendingAcpInteractions,
  ) {}

  static async open(
    url: string,
    handlers: ClientHandlers,
  ): Promise<AcpWebClient> {
    const interactions = new PendingAcpInteractions(handlers);
    const app = acp
      .client({ name: "model-kindergarten-web" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        try {
          handlers.onUpdate(params);
        } catch (error) {
          console.error("[acp-web] session/update handler failed", notificationFacts(params), error);
          throw error;
        }
      })
      .onNotification(
        CONTEXT_SUMMARY_NOTIFICATION,
        { parse: readContextSummaryNotification },
        ({ params }) => handlers.onContextSummary(params),
      )
      .onNotification(
        TOKEN_USAGE_NOTIFICATION,
        { parse: readTokenUsageNotification },
        ({ params }) => handlers.onTokenUsage(params),
      )
      .onNotification(
        TURN_STATE_NOTIFICATION,
        { parse: readTurnStateNotification },
        ({ params }) => handlers.onTurnState(params),
      )
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
        interactions.requestPermission(params),
      )
      .onRequest(acp.methods.client.elicitation.create, ({ params }) =>
        interactions.requestElicitation(params),
      );

    const stream = createWebSocketStream(url);
    const connection = app.connect(stream);
    const client = new AcpWebClient(connection, interactions);

    try {
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          elicitation: { form: {} },
          session: { configOptions: {} },
        },
        clientInfo: {
          name: "models-kindergarten-web",
          title: "Models Kindergarten Web",
          version: "0.1.0",
        },
      });
    } catch (error) {
      connection.close(error);
      throw error;
    }

    void connection.closed.then(() => {
      console.warn("[acp-web] connection closed");
      interactions.abandonAll();
      handlers.onClose();
    });
    return client;
  }

  list(cwd: string): Promise<acp.ListSessionsResponse> {
    return this.connection.agent.request(acp.methods.agent.session.list, { cwd });
  }

  create(cwd: string, binding: { modelStudentId: string; agentId: string }): Promise<acp.NewSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
      _meta: makeSessionBindingMeta({ schemaVersion: 1, ...binding }),
    });
  }

  createExperiment(cwd: string, experimentId: string, variantId: string): Promise<acp.NewSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
      _meta: makeExperimentRunRefMeta(experimentId, variantId),
    });
  }

  load(sessionId: string, cwd: string): Promise<acp.LoadSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers: [],
    });
  }

  /**
   * 只供“页面状态仍在、网络短暂重连”的场景使用。
   * resume 绝不承担历史加载。
   */
  resume(
    sessionId: string,
    cwd: string,
    cursor?: SessionResumeMeta,
  ): Promise<acp.ResumeSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd,
      mcpServers: [],
      ...(cursor ? { _meta: makeSessionResumeMeta(cursor) } : {}),
    });
  }

  closeSession(sessionId: string): Promise<acp.CloseSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.close, { sessionId });
  }

  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      value,
    });
  }

  prompt(
    sessionId: string,
    text: string,
    ids: PromptIds,
  ): Promise<acp.PromptResponse> {
    return this.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
      _meta: makePromptMeta({
        schemaVersion: 1,
        turnId: ids.turnId,
        ...(ids.operationId ? { operationId: ids.operationId } : {}),
        ...(ids.artifactMentions?.length ? { artifactMentions: ids.artifactMentions } : {}),
      }),
    });
  }

  cancel(sessionId: string): Promise<void> {
    return this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId,
    });
  }

  /**
   * UI 只提交用户决定，不接触 ACP request handler 的 Promise resolver。
   * resolver 的所有权留在连接对象，连接关闭时也能集中释放所有悬挂请求。
   */
  resolveInteraction(
    interaction: PendingInteractionState,
    value: acp.RequestPermissionResponse | acp.CreateElicitationResponse,
  ): void {
    this.interactions.resolve(interaction, value);
  }

  cancelInteractions(): void {
    this.interactions.cancelAll();
  }

  close(): void {
    this.interactions.abandonAll();
    this.connection.close();
  }
}

type PendingReply =
  | {
      kind: "permission";
      resolve: (value: acp.RequestPermissionResponse) => void;
    }
  | {
      kind: "elicitation";
      resolve: (value: acp.CreateElicitationResponse) => void;
    };

/** ACP Reverse Request 的 continuation 只存在于传输层，不进入 Zustand。 */
class PendingAcpInteractions {
  private readonly byId = new Map<string, PendingReply>();

  constructor(private readonly handlers: ClientHandlers) {}

  requestPermission(
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const id = makeTurnInteractionId("permission", request.toolCall.toolCallId);
    console.warn("[acp-web] permission received", {
      interactionId: id,
      sessionId: request.sessionId,
      toolCallId: request.toolCall.toolCallId,
      name: request.toolCall.name,
    });
    return new Promise((resolve) => {
      this.byId.set(id, { kind: "permission", resolve });
      this.handlers.onInteraction({ id, kind: "permission", request });
    });
  }

  requestElicitation(
    request: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    const toolCallId = "toolCallId" in request && typeof request.toolCallId === "string"
      ? request.toolCallId
      : crypto.randomUUID();
    const id = makeTurnInteractionId("elicitation", toolCallId);
    return new Promise((resolve) => {
      this.byId.set(id, { kind: "elicitation", resolve });
      this.handlers.onInteraction({ id, kind: "elicitation", request });
    });
  }

  resolve(
    interaction: PendingInteractionState,
    value: acp.RequestPermissionResponse | acp.CreateElicitationResponse,
  ): void {
    const pending = this.byId.get(interaction.id);
    if (!pending || pending.kind !== interaction.kind) return;
    console.warn("[acp-web] interaction resolved", {
      interactionId: interaction.id,
      kind: interaction.kind,
      sessionId: "sessionId" in interaction.request ? interaction.request.sessionId : undefined,
      toolCallId: interactionToolCallId(interaction),
    });
    this.byId.delete(interaction.id);
    if (pending.kind === "permission") {
      pending.resolve(value as acp.RequestPermissionResponse);
    } else {
      pending.resolve(value as acp.CreateElicitationResponse);
    }
    this.handlers.onInteractionResolved(interaction.id);
  }

  cancelAll(): void {
    for (const [id, pending] of [...this.byId]) {
      this.byId.delete(id);
      if (pending.kind === "permission") {
        pending.resolve({ outcome: { outcome: "cancelled" } });
      } else {
        pending.resolve({ action: "cancel" });
      }
      this.handlers.onInteractionResolved(id);
    }
  }

  /** 传输关闭不等于用户取消；只释放当前页面投影，不向 Remote 提交决定。 */
  abandonAll(): void {
    for (const id of [...this.byId.keys()]) {
      this.byId.delete(id);
      this.handlers.onInteractionResolved(id);
    }
  }
}

function notificationFacts(value: acp.SessionNotification) {
  const update = value.update;
  return {
    sessionId: value.sessionId,
    sessionUpdate: update.sessionUpdate,
    messageId: "messageId" in update ? update.messageId : undefined,
    toolCallId: "toolCallId" in update ? update.toolCallId : undefined,
    status: "status" in update ? update.status : undefined,
  };
}

function interactionToolCallId(interaction: PendingInteractionState): string | undefined {
  if (interaction.kind === "permission") return interaction.request.toolCall.toolCallId;
  return "toolCallId" in interaction.request && typeof interaction.request.toolCallId === "string"
    ? interaction.request.toolCallId
    : undefined;
}
