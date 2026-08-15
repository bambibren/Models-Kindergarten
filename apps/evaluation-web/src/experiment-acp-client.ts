import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { makeExperimentRunRefMeta, makePromptMeta } from "@kindergarten/contracts";

const REMOTE_CWD = "/workspace";

export class ExperimentAcpClient {
  private readonly activeSessions = new Set<string>();
  private constructor(
    private readonly connection: acp.ClientConnection,
    private readonly update: (value: acp.SessionNotification) => void,
  ) {}

  static async open(url: string, update: (value: acp.SessionNotification) => void, onClose: () => void) {
    const app = acp.client({ name: "model-kindergarten-evaluation-web" })
      .onNotification(acp.methods.client.session.update, ({ params }) => update(params))
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => ({
        outcome: window.confirm(`实验 lane 请求权限：${params.toolCall.title}\n\n是否允许本次执行？`)
          ? { outcome: "selected" as const, optionId: params.options.find((item) => item.kind === "allow_once")?.optionId ?? params.options[0]!.optionId }
          : { outcome: "cancelled" as const },
      }))
      .onRequest(acp.methods.client.elicitation.create, async ({ params }) => {
        const answer = window.prompt(params.message);
        if (answer === null) return { action: "cancel" as const };
        const schema = params.mode === "form" && isRecord(params.requestedSchema) ? params.requestedSchema : {};
        const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
        const properties = isRecord(schema.properties) ? schema.properties : {};
        const key = params.mode === "form" ? required[0] ?? Object.keys(properties)[0] ?? "answer" : undefined;
        return params.mode === "form" ? { action: "accept" as const, content: { [key!]: answer } } : { action: "accept" as const };
      });
    const connection = app.connect(createWebSocketStream(url));
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
      clientInfo: { name: "models-kindergarten-evaluation-web", version: "0.1.0" },
    });
    void connection.closed.then(onClose);
    return new ExperimentAcpClient(connection, update);
  }

  async run(
    experimentId: string,
    variantId: string,
    prompt: string,
    onSession: (sessionId: string) => void,
  ): Promise<{ sessionId: string; turnId: string; stopReason: acp.StopReason }> {
    const created = await this.connection.agent.request(acp.methods.agent.session.new, {
      cwd: REMOTE_CWD,
      mcpServers: [],
      _meta: makeExperimentRunRefMeta(experimentId, variantId),
    });
    onSession(created.sessionId);
    this.activeSessions.add(created.sessionId);
    const turnId = crypto.randomUUID();
    try {
      const response = await this.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: prompt }],
        _meta: makePromptMeta({ schemaVersion: 1, turnId }),
      });
      return { sessionId: created.sessionId, turnId, stopReason: response.stopReason };
    } finally { this.activeSessions.delete(created.sessionId); }
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.activeSessions].map((sessionId) => this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })));
  }

  close() { this.connection.close(); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
