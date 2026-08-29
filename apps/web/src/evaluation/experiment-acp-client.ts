import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { makeExperimentRunRefMeta, makePromptMeta } from "@kindergarten/contracts";

const REMOTE_CWD = "/workspace";

/** 描述「ExperimentIntervention」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ExperimentIntervention = PermissionIntervention | ElicitationIntervention;

/** 描述「PermissionIntervention」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface PermissionIntervention {
  interventionId: string;
  kind: "permission";
  title: string;
  detail: string;
  options: Array<{ optionId: string; kind: string; name: string }>;
  respond: (optionId?: string) => Promise<void>;
}

/** 描述「ElicitationIntervention」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ElicitationIntervention {
  interventionId: string;
  kind: "elicitation";
  title: string;
  message: string;
  fields: ElicitationField[];
  respond: (content?: Record<string, unknown>) => Promise<void>;
}

/** 描述「ElicitationField」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ElicitationField {
  name: string;
  label: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  enumValues?: Array<string | number>;
}

/** 描述「ExperimentAcpClient」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ExperimentAcpClient {
  private readonly activeSessions = new Set<string>();

  /** 初始化「ExperimentAcpClient」所需依赖，不在构造阶段启动不可回收的后台任务。 */
private constructor(
    private readonly connection: acp.ClientConnection,
    private readonly update: (value: acp.SessionNotification) => void,
    private readonly sessionTests: Map<string, { experimentId: string; testId: string }>,
  ) {}

  /** 执行「open」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
static async open(
    url: string,
    update: (value: acp.SessionNotification) => void,
    onIntervention: (testId: string, intervention: ExperimentIntervention) => void,
    onInterventionResolved: (experimentId: string, testId: string, fact: { interactionId: string; kind: "permission" | "elicitation"; summary: string; decision: string }) => Promise<void>,
    onClose: () => void,
  ) {
    const sessionTests = new Map<string, { experimentId: string; testId: string }>();
    const app = acp.client({ name: "models-kindergarten-web-evaluation" })
      .onNotification(acp.methods.client.session.update, /** 处理「onRequest」事件，校验归属后再推进状态且避免重复提交。 */
({ params }) => update(params))
      .onRequest(acp.methods.client.session.requestPermission, /** 处理「onRequest」事件，校验归属后再推进状态且避免重复提交。 */
async ({ params }) => {
        const ref = sessionTests.get(params.sessionId);
        if (!ref) return { outcome: { outcome: "cancelled" as const } };
        const interactionId = crypto.randomUUID();
        return new Promise(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve) => onIntervention(ref.testId, {
          interventionId: interactionId,
          kind: "permission",
          title: params.toolCall.title ?? "Tool 权限请求",
          detail: permissionDetail(params.toolCall),
          options: params.options.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ optionId: item.optionId, kind: item.kind, name: item.name })),
          respond: /** 处理「respond」事件，校验归属后再推进状态且避免重复提交。 */
async (optionId) => {
            const selected = params.options.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.optionId === optionId);
            await onInterventionResolved(ref.experimentId, ref.testId, {
              interactionId, kind: "permission", summary: params.toolCall.title ?? "Tool 权限请求",
              decision: selected?.kind ?? "cancelled",
            });
            resolve({ outcome: optionId ? { outcome: "selected" as const, optionId } : { outcome: "cancelled" as const } });
          },
        }));
      })
      .onRequest(acp.methods.client.elicitation.create, /** 完成当前异步桥接，并保证每条分支只结算一次。 */
async ({ params }) => {
        const rawParams: unknown = params;
        const sessionId = isRecord(rawParams) && typeof rawParams.sessionId === "string" ? rawParams.sessionId : undefined;
        const ref = sessionId ? sessionTests.get(sessionId) : undefined;
        if (!ref) return { action: "cancel" as const };
        const interactionId = crypto.randomUUID();
        return new Promise(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve) => onIntervention(ref.testId, {
          interventionId: interactionId,
          kind: "elicitation",
          title: "Agent 需要你的回答",
          message: params.message,
          fields: params.mode === "form" ? elicitationFields(params.requestedSchema) : [],
          respond: /** 处理「respond」事件，校验归属后再推进状态且避免重复提交。 */
async (content) => {
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
      clientInfo: { name: "models-kindergarten-web-evaluation", version: "0.2.0" },
    });
    void connection.closed.then(onClose);
    return new ExperimentAcpClient(connection, update, sessionTests);
  }

  /** 执行「run」主流程，传播取消与失败并在结束时清理临时资源。 */
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
    } finally {
      this.activeSessions.delete(created.sessionId);
      this.sessionTests.delete(created.sessionId);
    }
  }

  /** 判断「cancelAll」对应条件，只返回判定结果且不修改输入状态。 */
async cancelAll(): Promise<void> {
    await Promise.all([...this.activeSessions].map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(sessionId) => this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })));
  }

  /** 释放或删除「close」对应资源，重复调用仍保持安全。 */
close() { this.connection.close(); }
}

/** 执行「elicitationFields」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function elicitationFields(schema: unknown): ElicitationField[] {
  if (!isRecord(schema)) return [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item): item is string => typeof item === "string") : []);
  return Object.entries(properties).flatMap(/** 执行「elicitationFields」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
([name, raw]) => {
    if (!isRecord(raw)) return [];
    const type = raw.type === "number" || raw.type === "integer" ? "number" : raw.type === "boolean" ? "boolean" : "string";
    const enumValues = Array.isArray(raw.enum)
      ? raw.enum.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item): item is string | number => typeof item === "string" || typeof item === "number")
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

/** 执行「permissionDetail」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function permissionDetail(toolCall: unknown): string {
  if (!isRecord(toolCall)) return "";
  const rawInput = toolCall.rawInput ?? toolCall.input;
  return rawInput === undefined ? "" : JSON.stringify(rawInput, null, 2);
}
/** 判断「isRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
