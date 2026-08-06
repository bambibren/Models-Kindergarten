import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { makePromptMeta } from "@kindergarten/contracts";

export interface PromptIds {
  turnId: string;
}

export interface ClientHandlers {
  onUpdate: (value: acp.SessionNotification) => void;
  onPermission: (
    value: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
  onElicitation: (
    value: acp.CreateElicitationRequest,
  ) => Promise<acp.CreateElicitationResponse>;
  onClose: () => void;
}

/**
 * 浏览器只有一个 ACP 连接拥有者。
 * 这里不做自动重试，避免旧系统中“连接恢复”和“历史回放”互相触发。
 */
export class AcpWebClient {
  private constructor(private readonly connection: acp.ClientConnection) {}

  static async open(
    url: string,
    handlers: ClientHandlers,
  ): Promise<AcpWebClient> {
    const app = acp
      .client({ name: "model-kindergarten-web" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        handlers.onUpdate(params);
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
        handlers.onPermission(params),
      )
      .onRequest(acp.methods.client.elicitation.create, ({ params }) =>
        handlers.onElicitation(params),
      );

    const stream = createWebSocketStream(url);
    const connection = app.connect(stream);
    const client = new AcpWebClient(connection);

    try {
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          elicitation: { form: {} },
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

    void connection.closed.then(handlers.onClose);
    return client;
  }

  list(cwd: string): Promise<acp.ListSessionsResponse> {
    return this.connection.agent.request(acp.methods.agent.session.list, { cwd });
  }

  create(cwd: string): Promise<acp.NewSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
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
  resume(sessionId: string, cwd: string): Promise<acp.ResumeSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd,
      mcpServers: [],
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
      }),
    });
  }

  cancel(sessionId: string): Promise<void> {
    return this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId,
    });
  }

  close(): void {
    this.connection.close();
  }
}
