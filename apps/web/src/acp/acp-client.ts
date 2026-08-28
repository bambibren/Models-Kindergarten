import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import {
  CONTEXT_SUMMARY_NOTIFICATION,
  CONTEXT_WINDOW_USAGE_NOTIFICATION,
  TOKEN_USAGE_NOTIFICATION,
  TURN_STATE_NOTIFICATION,
  makeExperimentRunRefMeta,
  makeTurnInteractionId,
  makePromptMeta,
  makeSessionResumeMeta,
  makeSessionBindingMeta,
  readContextSummaryNotification,
  readContextWindowUsageNotification,
  readTokenUsageNotification,
  readTurnStateNotification,
  type ContextSummaryNotification,
  type ContextWindowUsageNotification,
  type TokenUsageNotification,
  type TurnStateNotification,
  type SessionResumeMeta,
  type ArtifactMentionInput,
} from "@kindergarten/contracts";
import type { PendingInteractionState } from "../prompt-turn/prompt-turn-types.js";

/** 描述「PromptIds」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface PromptIds {
  turnId: string;
  operationId?: string;
  artifactMentions?: ArtifactMentionInput[];
}

/** 描述「ClientHandlers」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ClientHandlers {
  onUpdate: (value: acp.SessionNotification) => void;
  onContextSummary: (value: ContextSummaryNotification) => void;
  onTokenUsage: (value: TokenUsageNotification) => void;
  onContextWindowUsage: (value: ContextWindowUsageNotification) => void;
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
  /** 初始化「AcpWebClient」所需依赖，不在构造阶段启动不可回收的后台任务。 */
private constructor(
    private readonly connection: acp.ClientConnection,
    private readonly interactions: PendingAcpInteractions,
  ) {}

  /** 执行「open」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
static async open(
    url: string,
    handlers: ClientHandlers,
  ): Promise<AcpWebClient> {
    const interactions = new PendingAcpInteractions(handlers);
    const app = acp
      .client({ name: "model-kindergarten-web" })
      .onNotification(acp.methods.client.session.update, /** 处理「onNotification」事件，校验归属后再推进状态且避免重复提交。 */
({ params }) => {
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
        /** 处理「onNotification」事件，校验归属后再推进状态且避免重复提交。 */
({ params }) => handlers.onContextSummary(params),
      )
      .onNotification(
        TOKEN_USAGE_NOTIFICATION,
        { parse: readTokenUsageNotification },
        /** 处理「onNotification」事件，校验归属后再推进状态且避免重复提交。 */
({ params }) => handlers.onTokenUsage(params),
      )
      .onNotification(
        CONTEXT_WINDOW_USAGE_NOTIFICATION,
        { parse: readContextWindowUsageNotification },
        /** 处理「onNotification」事件，校验归属后再推进状态且避免重复提交。 */
({ params }) => handlers.onContextWindowUsage(params),
      )
      .onNotification(
        TURN_STATE_NOTIFICATION,
        { parse: readTurnStateNotification },
        /** 处理「onRequest」事件，校验归属后再推进状态且避免重复提交。 */
({ params }) => handlers.onTurnState(params),
      )
      .onRequest(acp.methods.client.session.requestPermission, /** 处理「onRequest」事件，校验归属后再推进状态且避免重复提交。 */
({ params }) =>
        interactions.requestPermission(params),
      )
      .onRequest(acp.methods.client.elicitation.create, /** 执行「app」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params }) =>
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

    void connection.closed.then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => {
      console.warn("[acp-web] connection closed");
      interactions.abandonAll();
      handlers.onClose();
    });
    return client;
  }

  /** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
list(cwd: string): Promise<acp.ListSessionsResponse> {
    return this.connection.agent.request(acp.methods.agent.session.list, { cwd });
  }

  /** 根据已校验输入构建「create」结果，不额外持有调用方的大对象。 */
create(cwd: string, binding: { modelStudentId: string; agentId: string }): Promise<acp.NewSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
      _meta: makeSessionBindingMeta({ schemaVersion: 1, ...binding }),
    });
  }

  /** 根据已校验输入构建「createExperiment」结果，不额外持有调用方的大对象。 */
createExperiment(cwd: string, experimentId: string, variantId: string): Promise<acp.NewSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
      _meta: makeExperimentRunRefMeta(experimentId, variantId),
    });
  }

  /** 读取「load」所需数据，并遵守作用域、分页与容量边界。 */
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

  /** 释放或删除「closeSession」对应资源，重复调用仍保持安全。 */
closeSession(sessionId: string): Promise<acp.CloseSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.close, { sessionId });
  }

  /** 更新「setConfigOption」对应状态，并保持写入顺序、原子性与容量约束。 */
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

  /** 通过当前唯一 ACP connection owner 提交 Prompt；终态只能以 Remote 响应和通知为准。 */
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

  /** 判断「cancel」对应条件，只返回判定结果且不修改输入状态。 */
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

  /** 判断「cancelInteractions」对应条件，只返回判定结果且不修改输入状态。 */
cancelInteractions(): void {
    this.interactions.cancelAll();
  }

  /** 释放或删除「close」对应资源，重复调用仍保持安全。 */
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

  /** 初始化「PendingAcpInteractions」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly handlers: ClientHandlers) {}

  /** 执行「requestPermission」主流程，传播取消与失败并在结束时清理临时资源。 */
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
    return new Promise(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve) => {
      this.byId.set(id, { kind: "permission", resolve });
      this.handlers.onInteraction({ id, kind: "permission", request });
    });
  }

  /** 执行「requestElicitation」主流程，传播取消与失败并在结束时清理临时资源。 */
requestElicitation(
    request: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    const toolCallId = "toolCallId" in request && typeof request.toolCallId === "string"
      ? request.toolCallId
      : crypto.randomUUID();
    const id = makeTurnInteractionId("elicitation", toolCallId);
    return new Promise(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve) => {
      this.byId.set(id, { kind: "elicitation", resolve });
      this.handlers.onInteraction({ id, kind: "elicitation", request });
    });
  }

  /** 执行「resolve」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

  /** 判断「cancelAll」对应条件，只返回判定结果且不修改输入状态。 */
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

/** 生成「notificationFacts」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
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

/** 由规范字段生成稳定的「interactionToolCallId」标识，供索引精确定位且不保留原始大对象。 */
function interactionToolCallId(interaction: PendingInteractionState): string | undefined {
  if (interaction.kind === "permission") return interaction.request.toolCall.toolCallId;
  return "toolCallId" in interaction.request && typeof interaction.request.toolCallId === "string"
    ? interaction.request.toolCallId
    : undefined;
}
