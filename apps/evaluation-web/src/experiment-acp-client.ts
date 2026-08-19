import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { makeExperimentRunRefMeta, makePromptMeta } from "@kindergarten/contracts";

const REMOTE_CWD = "/workspace";

export type ExperimentIntervention = PermissionIntervention | ElicitationIntervention;

export interface PermissionIntervention {
  interventionId: string;
  kind: "permission";
  title: string;
  detail: string;
  options: Array<{ optionId: string; kind: string; name: string }>;
  respond: (optionId?: string) => Promise<void>;
}

export interface ElicitationIntervention {
  interventionId: string;
  kind: "elicitation";
  title: string;
  message: string;
  fields: ElicitationField[];
  respond: (content?: Record<string, unknown>) => Promise<void>;
}

export interface ElicitationField {
  name: string;
  label: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  enumValues?: Array<string | number>;
}

export class ExperimentAcpClient {
  private readonly activeSessions = new Set<string>();

  private constructor(
    private readonly connection: acp.ClientConnection,
    private readonly update: (value: acp.SessionNotification) => void,
    private readonly sessionTests: Map<string, { experimentId: string; testId: string }>,
  ) {}

  static async open(
    url: string,
    update: (value: acp.SessionNotification) => void,
    onIntervention: (testId: string, intervention: ExperimentIntervention) => void,
    onInterventionResolved: (experimentId: string, testId: string, fact: { interactionId: string; kind: "permission" | "elicitation"; summary: string; decision: string }) => Promise<void>,
    onClose: () => void,
  ) {
    const sessionTests = new Map<string, { experimentId: string; testId: string }>();
    const app = acp.client({ name: "model-kindergarten-evaluation-web" })
      .onNotification(acp.methods.client.session.update, ({ params }) => update(params))
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        const ref = sessionTests.get(params.sessionId);
        if (!ref) return { outcome: { outcome: "cancelled" as const } };
        const interactionId = crypto.randomUUID();
        return new Promise((resolve) => onIntervention(ref.testId, {
          interventionId: interactionId,
          kind: "permission",
          title: params.toolCall.title ?? "Tool 权限请求",
          detail: permissionDetail(params.toolCall),
          options: params.options.map((item) => ({ optionId: item.optionId, kind: item.kind, name: item.name })),
          respond: async (optionId) => {
            const selected = params.options.find((item) => item.optionId === optionId);
            await onInterventionResolved(ref.experimentId, ref.testId, {
              interactionId, kind: "permission", summary: params.toolCall.title ?? "Tool 权限请求",
              decision: selected?.kind ?? "cancelled",
            });
            resolve({ outcome: optionId ? { outcome: "selected" as const, optionId } : { outcome: "cancelled" as const } });
          },
        }));
      })
      .onRequest(acp.methods.client.elicitation.create, async ({ params }) => {
        const rawParams: unknown = params;
        const sessionId = isRecord(rawParams) && typeof rawParams.sessionId === "string" ? rawParams.sessionId : undefined;
        const ref = sessionId ? sessionTests.get(sessionId) : undefined;
        if (!ref) return { action: "cancel" as const };
        const interactionId = crypto.randomUUID();
        return new Promise((resolve) => onIntervention(ref.testId, {
          interventionId: interactionId,
          kind: "elicitation",
          title: "Agent 需要你的回答",
          message: params.message,
          fields: params.mode === "form" ? elicitationFields(params.requestedSchema) : [],
          respond: async (content) => {
            await onInterventionResolved(ref.experimentId, ref.testId, {
              interactionId, kind: "elicitation", summary: params.message,
              decision: content === undefined ? "cancelled" : "accepted",
            });
            resolve(content === undefined ? { action: "cancel" as const } : params.mode === "form"
              ? { action: "accept" as const, content } : { action: "accept" as const });
          },
        }));
      });
    const connection = app.connect(createWebSocketStream(url));
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
      clientInfo: { name: "models-kindergarten-evaluation-web", version: "0.2.0" },
    });
    void connection.closed.then(onClose);
    return new ExperimentAcpClient(connection, update, sessionTests);
  }

  async run(
    experimentId: string,
    testId: string,
    prompt: string,
    onSession: (sessionId: string) => void,
  ): Promise<{ sessionId: string; turnId: string; stopReason: acp.StopReason }> {
    const created = await this.connection.agent.request(acp.methods.agent.session.new, {
      cwd: REMOTE_CWD,
      mcpServers: [],
      _meta: makeExperimentRunRefMeta(experimentId, testId),
    });
    this.sessionTests.set(created.sessionId, { experimentId, testId });
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

export function elicitationFields(schema: unknown): ElicitationField[] {
  if (!isRecord(schema)) return [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  return Object.entries(properties).flatMap(([name, raw]) => {
    if (!isRecord(raw)) return [];
    const type = raw.type === "number" || raw.type === "integer" ? "number" : raw.type === "boolean" ? "boolean" : "string";
    const enumValues = Array.isArray(raw.enum)
      ? raw.enum.filter((item): item is string | number => typeof item === "string" || typeof item === "number")
      : undefined;
    return [{
      name,
      label: typeof raw.title === "string" ? raw.title : name,
      type,
      required: required.has(name),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
    }];
  });
}

function permissionDetail(toolCall: unknown): string {
  if (!isRecord(toolCall)) return "";
  const rawInput = toolCall.rawInput ?? toolCall.input;
  return rawInput === undefined ? "" : JSON.stringify(rawInput, null, 2);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
