import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { readPromptMeta } from "@kindergarten/contracts";
import { AcpOutput } from "./acp-output.js";
import type {
  AgentRuntime,
  RunObserver,
} from "../runtime/agent-runtime.js";
import type { SessionRepository } from "../repository/session-repository.js";
import type {
  SessionEntry,
  SessionMessageEntry,
  SessionRecord,
  SessionThoughtEntry,
  SessionToolCallEntry,
} from "../repository/session-types.js";
import type { PreparedToolCall, ToolOutcome } from "../tools/tool-registry.js";
import { RunFailure } from "../runtime/run-failure.js";

/** ACP Adapter 负责会话、双向用户交互和 ChatEntry 输出，不实现模型或文件逻辑。 */
export class KindergartenAgent {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly runtime: AgentRuntime,
  ) {}

  createApp(): acp.AgentApp {
    return acp
      .agent({ name: "model-kindergarten-remote" })
      .onRequest(acp.methods.agent.initialize, ({ params }) => this.initialize(params))
      .onRequest(acp.methods.agent.session.new, ({ params }) => this.newSession(params))
      .onRequest(acp.methods.agent.session.list, ({ params }) => this.listSessions(params))
      .onRequest(acp.methods.agent.session.load, ({ params, client }) =>
        this.loadSession(params, client),
      )
      .onRequest(acp.methods.agent.session.resume, ({ params }) =>
        this.resumeSession(params),
      )
      .onRequest(acp.methods.agent.session.close, ({ params }) =>
        this.closeSession(params),
      )
      .onRequest(acp.methods.agent.session.prompt, ({ params, client, signal }) =>
        this.prompt(params, client, signal),
      )
      .onNotification(acp.methods.agent.session.cancel, ({ params }) =>
        this.cancel(params.sessionId),
      );
  }

  private initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    return {
      protocolVersion:
        params.protocolVersion === acp.PROTOCOL_VERSION
          ? params.protocolVersion
          : acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      agentInfo: {
        name: "models-kindergarten",
        title: "Models Kindergarten",
        version: "0.2.0",
      },
    };
  }

  private async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const session = await this.sessions.create(params.cwd);
    return { sessionId: session.id };
  }

  private async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    return { sessions: await this.sessions.list(params.cwd) };
  }

  private async loadSession(
    params: acp.LoadSessionRequest,
    client: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    const session = await this.requireSession(params.sessionId, params.cwd);
    const output = new AcpOutput(session.id, client);
    for (const entry of session.sessionEntries) await replayEntry(output, entry);
    return {};
  }

  private async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    await this.requireSession(params.sessionId, params.cwd);
    return {};
  }

  private async closeSession(params: acp.CloseSessionRequest): Promise<void> {
    this.cancel(params.sessionId);
  }

  private async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
    requestSignal: AbortSignal,
  ): Promise<acp.PromptResponse> {
    if (this.active.has(params.sessionId)) {
      throw new acp.RequestError(-32000, "这个会话已有一轮回答正在生成");
    }

    const text = promptText(params.prompt);
    if (!text) throw new Error("初版只接受非空文本消息");

    const session = await this.sessions.get(params.sessionId);
    const turnId = readPromptMeta(params._meta)?.turnId ?? randomUUID();
    const output = new AcpOutput(session.id, client);
    const controller = new AbortController();
    const unlink = linkAbort(requestSignal, controller);
    this.active.set(session.id, controller);

    const user = makeMessage("user", text, turnId, randomUUID());
    await output.message("user", user.messageId, text, {
      schemaVersion: 1,
      turnId,
      chunkIndex: 0,
      final: true,
    });

    const projection = new TurnProjection(
      session.id,
      turnId,
      output,
      client,
    );
    projection.streamingSessionEntries.push(user);
    let failure: unknown = null;
    let reason: acp.StopReason = "end_turn";

    try {
      const result = await this.runtime.run(
        { text, sessionEntries: session.sessionEntries },
        projection,
        controller.signal,
      );
      if (result.reason === "cancelled") reason = "cancelled";
      else if (result.reason === "length") reason = "max_tokens";
    } catch (error) {
      failure = error;
    } finally {
      await projection.finalizeOpenRounds();
      await this.sessions.appendMany(session.id, projection.streamingSessionEntries);
      unlink();
      this.active.delete(session.id);
    }

    if (failure instanceof RunFailure) {
      // 详细 cause 只写 Remote 日志；ACP 仅承载 Turn 失败的可读原因。
      console.error("Prompt Turn 执行失败", failure.cause ?? failure);
      throw new acp.RequestError(-32001, failure.message);
    }
    if (failure) throw failure;
    return { stopReason: reason };
  }

  private cancel(sessionId: string): void {
    this.active.get(sessionId)?.abort();
  }

  private async requireSession(id: string, cwd: string): Promise<SessionRecord> {
    const session = await this.sessions.get(id);
    if (session.cwd !== cwd) throw new Error("会话 cwd 与请求不一致");
    return session;
  }
}

class TurnProjection implements RunObserver {
  readonly streamingSessionEntries: SessionEntry[] = [];
  private readonly messages = new Map<number, SessionMessageEntry>();
  private readonly thoughts = new Map<number, SessionThoughtEntry>();
  private readonly messageChunks = new Map<number, number>();
  private readonly thoughtChunks = new Map<number, number>();
  private readonly closedRounds = new Set<number>();

  constructor(
    private readonly sessionId: string,
    private readonly turnId: string,
    private readonly output: AcpOutput,
    private readonly client: acp.AgentContext,
  ) {}

  async text(round: number, value: string): Promise<void> {
    const entry = this.ensureMessage(round);
    entry.text += value;
    const index = this.messageChunks.get(round) ?? 0;
    this.messageChunks.set(round, index + 1);
    await this.output.message("assistant", entry.messageId, value, {
      schemaVersion: 1,
      turnId: this.turnId,
      chunkIndex: index,
    });
  }

  async thought(round: number, value: string): Promise<void> {
    const entry = this.ensureThought(round);
    entry.text += value;
    const index = this.thoughtChunks.get(round) ?? 0;
    this.thoughtChunks.set(round, index + 1);
    await this.output.thought(entry.messageId, value, {
      schemaVersion: 1,
      turnId: this.turnId,
      chunkIndex: index,
    });
  }

  async roundComplete(round: number): Promise<void> {
    if (this.closedRounds.has(round)) return;
    this.closedRounds.add(round);
    const message = this.messages.get(round);
    if (message) {
      await this.output.message("assistant", message.messageId, "", {
        schemaVersion: 1,
        turnId: this.turnId,
        chunkIndex: this.messageChunks.get(round) ?? 0,
        final: true,
      });
    }
    const thought = this.thoughts.get(round);
    if (thought) {
      await this.output.thought(thought.messageId, "", {
        schemaVersion: 1,
        turnId: this.turnId,
        chunkIndex: this.thoughtChunks.get(round) ?? 0,
        final: true,
      });
    }
  }

  async finalizeOpenRounds(): Promise<void> {
    const rounds = new Set([...this.messages.keys(), ...this.thoughts.keys()]);
    for (const round of rounds) await this.roundComplete(round);
  }

  async toolStart(call: PreparedToolCall): Promise<void> {
    const entry: SessionToolCallEntry = {
      type: "tool_call",
      turnId: this.turnId,
      toolCallId: call.id,
      title: call.title,
      name: call.name,
      kind: call.kind,
      status: "pending",
      rawInput: call.arguments,
      content: [],
      locations: call.locations,
      createdAt: new Date().toISOString(),
    };
    this.streamingSessionEntries.push(entry);
    await this.output.toolCall({
      toolCallId: call.id,
      title: call.title,
      name: call.name,
      kind: call.kind,
      status: "pending",
      rawInput: call.arguments,
      locations: call.locations,
    });
  }

  async toolFinish(
    call: PreparedToolCall,
    status: acp.ToolCallStatus,
    result: ToolOutcome,
  ): Promise<void> {
    const entry = this.streamingSessionEntries.find(
      (item): item is SessionToolCallEntry =>
        item.type === "tool_call" && item.toolCallId === call.id,
    );
    const content = "content" in result ? result.content : [];
    const locations = "locations" in result ? result.locations : call.locations;
    if (entry) {
      entry.status = status;
      entry.rawOutput = result.rawOutput;
      entry.modelContent = result.modelContent;
      entry.outcomeStatus = result.status;
      entry.content = content;
      entry.locations = locations;
    }
    await this.output.toolUpdate({
      toolCallId: call.id,
      status,
      rawOutput: result.rawOutput,
      content,
      locations,
    });
  }

  async requestPermission(call: PreparedToolCall): Promise<boolean> {
    const response = await this.client.request(
      acp.methods.client.session.requestPermission,
      {
        sessionId: this.sessionId,
        toolCall: {
          toolCallId: call.id,
          title: call.title,
          name: call.name,
          kind: call.kind,
          status: "pending",
          rawInput: call.arguments,
          locations: call.locations,
        },
        options: [
          { optionId: "allow-once", name: "允许本次执行", kind: "allow_once" },
          { optionId: "reject-once", name: "拒绝本次执行", kind: "reject_once" },
        ],
      },
    );
    return (
      response.outcome.outcome === "selected" &&
      response.outcome.optionId === "allow-once"
    );
  }

  async askUser(question: string, toolCallId: string): Promise<string> {
    const response = await this.client.request(
      acp.methods.client.elicitation.create,
      {
        sessionId: this.sessionId,
        toolCallId,
        mode: "form",
        message: question,
        requestedSchema: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              title: "你的回答",
              minLength: 1,
              maxLength: 4000,
            },
          },
          required: ["answer"],
        },
      },
    );
    if (response.action !== "accept") {
      // AskUser 的取消语义是停止当前 Turn，不应伪装成一次 Tool 执行失败。
      throw new DOMException("用户取消了回答", "AbortError");
    }
    const answer = isRecord(response.content) ? response.content.answer : undefined;
    if (typeof answer !== "string" || answer.trim().length === 0) {
      throw new Error("用户没有提供有效回答");
    }
    return answer;
  }

  private ensureMessage(round: number): SessionMessageEntry {
    const existing = this.messages.get(round);
    if (existing) return existing;
    const entry = makeMessage("assistant", "", this.turnId, randomUUID());
    this.messages.set(round, entry);
    this.streamingSessionEntries.push(entry);
    return entry;
  }

  private ensureThought(round: number): SessionThoughtEntry {
    const existing = this.thoughts.get(round);
    if (existing) return existing;
    const entry: SessionThoughtEntry = {
      type: "thought",
      text: "",
      turnId: this.turnId,
      messageId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.thoughts.set(round, entry);
    this.streamingSessionEntries.push(entry);
    return entry;
  }
}

async function replayEntry(output: AcpOutput, entry: SessionEntry): Promise<void> {
  if (entry.type === "message") {
    await output.message(entry.role, entry.messageId, entry.text, {
      schemaVersion: 1,
      turnId: entry.turnId,
      chunkIndex: 0,
      final: true,
    });
  } else if (entry.type === "thought") {
    await output.thought(entry.messageId, entry.text, {
      schemaVersion: 1,
      turnId: entry.turnId,
      chunkIndex: 0,
      final: true,
    });
  } else {
    await output.toolCall({
      toolCallId: entry.toolCallId,
      title: entry.title,
      name: entry.name,
      kind: entry.kind,
      status: entry.status,
      rawInput: entry.rawInput,
      rawOutput: entry.rawOutput,
      content: entry.content,
      locations: entry.locations,
    });
  }
}

function promptText(content: acp.ContentBlock[]): string {
  return content
    .flatMap((item) => {
      if (item.type === "text") return [item.text];
      if (item.type === "resource_link") {
        return [`[资源链接] ${item.title ?? item.name}: ${item.uri}`];
      }
      return [];
    })
    .join("\n")
    .trim();
}

function makeMessage(
  role: SessionMessageEntry["role"],
  text: string,
  turnId: string,
  messageId: string,
): SessionMessageEntry {
  return {
    type: "message",
    role,
    text,
    turnId,
    messageId,
    createdAt: new Date().toISOString(),
  };
}

function linkAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort();
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
