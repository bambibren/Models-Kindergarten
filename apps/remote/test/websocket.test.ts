import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { KindergartenAgent } from "../src/acp/kindergarten-agent.js";
import { FixtureProvider } from "../src/model/fixture-provider.js";
import type {
  ModelContextFragment,
  ModelContextSerialization,
  ModelEvent,
  ModelInput,
  ModelProvider,
  ModelStudent,
} from "../src/model/model-provider.js";
import { SessionRepository } from "../src/repository/session-repository.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { RemoteServer } from "../src/server/http-server.js";
import { FileSandbox } from "../src/tools/sandbox.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { SessionBindingService } from "../src/session/session-binding-service.js";
import {
  TURN_STATE_NOTIFICATION,
  makePromptMeta,
  makeSessionBindingMeta,
  makeSessionResumeMeta,
  readTurnStateNotification,
  type TurnStateNotification,
} from "@kindergarten/contracts";

let dir = "";
let server: RemoteServer | undefined;
let client: acp.ClientConnection | undefined;

afterEach(async () => {
  client?.close();
  await client?.closed;
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  client = undefined;
  server = undefined;
  dir = "";
});

describe("ACP WebSocket", () => {
  it("通过真实 WebSocket 完成 initialize/new/prompt", async () => {
    dir = await mkdtemp(join(tmpdir(), "kindergarten-ws-"));
    const sessions = new SessionRepository(dir);
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const runtime = AgentRuntime.fromRegistry(
      new FixtureProvider(),
      new ToolRegistry(sandbox),
    );
    const bindings = new SessionBindingService({
      workspaceCwd: "/workspace",
      agentExists: (id) => id === "agent-1",
      modelStudentReady: (id) => id === "student-1",
      experimentBinding: async () => undefined,
    });
    const agent = new KindergartenAgent(sessions, runtime, bindings).createApp();
    server = new RemoteServer(agent);
    await server.listen("127.0.0.1", 0);

    const address = server.http.address() as AddressInfo;
    const updates: acp.SessionNotification[] = [];
    const app = acp
      .client({ name: "websocket-test" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });
    const stream = createWebSocketStream(
      `ws://127.0.0.1:${address.port}/acp`,
      { WebSocket },
    );
    client = app.connect(stream);

    const initialized = await client.agent.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      },
    );
    expect(initialized.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    expect(updates).toHaveLength(0);

    const created = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: makeSessionBindingMeta({ schemaVersion: 1, modelStudentId: "student-1", agentId: "agent-1" }),
    });
    const stopped = await client.agent.request(
      acp.methods.agent.session.prompt,
      {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "WebSocket 冒烟测试" }],
      },
    );

    expect(stopped.stopReason).toBe("end_turn");
    expect(updates.some(isAssistantText)).toBe(true);
  });

  it("真实 WebSocket 断开后 Runtime 继续，手动 resume 补齐缺失输出", async () => {
    dir = await mkdtemp(join(tmpdir(), "kindergarten-ws-resume-"));
    const sessions = new SessionRepository(dir);
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const provider = new DisconnectProvider();
    const bindings = new SessionBindingService({
      workspaceCwd: "/workspace",
      agentExists: (id) => id === "agent-1",
      modelStudentReady: (id) => id === "student-1",
      experimentBinding: async () => undefined,
    });
    server = new RemoteServer(new KindergartenAgent(
      sessions,
      AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox)),
      bindings,
    ).createApp());
    await server.listen("127.0.0.1", 0);
    const address = server.http.address() as AddressInfo;

    const firstUpdates: acp.SessionNotification[] = [];
    const first = await openWebSocketClient(address.port, firstUpdates);
    client = first;
    const created = await first.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: makeSessionBindingMeta({ schemaVersion: 1, modelStudentId: "student-1", agentId: "agent-1" }),
    });
    const running = first.agent.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "真实断线" }],
      _meta: makePromptMeta({ schemaVersion: 1, turnId: "turn-ws-resume" }),
    }).then((value) => value, (error: unknown) => error);
    await provider.firstChunk;
    await waitUntil(() => messageTexts(firstUpdates).some(([, text]) => text === "第一段"));
    const received = messageTexts(firstUpdates);
    const user = received.find(([, text]) => text === "真实断线")!;
    const assistant = received.find(([, text]) => text === "第一段")!;

    first.close();
    await first.closed;
    provider.continue();
    await provider.completed;
    expect(provider.aborted).toBe(false);
    await running;

    const resumedUpdates: acp.SessionNotification[] = [];
    const resumedStates: TurnStateNotification[] = [];
    const resumed = await openWebSocketClient(address.port, resumedUpdates, resumedStates);
    client = resumed;
    await resumed.agent.request(acp.methods.agent.session.resume, {
      sessionId: created.sessionId,
      cwd: "/workspace",
      mcpServers: [],
      _meta: makeSessionResumeMeta({
        schemaVersion: 1,
        turnId: "turn-ws-resume",
        messages: {
          [user[0]]: { textLength: user[1].length, nextChunkIndex: 1 },
          [assistant[0]]: { textLength: assistant[1].length, nextChunkIndex: 1 },
        },
        thoughts: {},
      }),
    });

    expect(messageTexts(resumedUpdates)).toEqual([[assistant[0], "第二段"]]);
    await waitUntil(() => resumedStates.some((item) => item.turn.status === "completed"));
    expect(resumedStates.at(-1)?.turn.status).toBe("completed");
  });
});

function isAssistantText(notice: acp.SessionNotification): boolean {
  const update = notice.update;
  return (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content.type === "text" &&
    update.content.text.length > 0
  );
}

async function openWebSocketClient(
  port: number,
  updates: acp.SessionNotification[],
  turns: TurnStateNotification[] = [],
): Promise<acp.ClientConnection> {
  const app = acp
    .client({ name: "websocket-resume-test" })
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); })
    .onNotification(TURN_STATE_NOTIFICATION, readTurnStateNotification, ({ params }) => { turns.push(params); });
  const connection = app.connect(createWebSocketStream(`ws://127.0.0.1:${port}/acp`, { WebSocket }));
  await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  return connection;
}

class DisconnectProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "student-1",
    name: "Disconnect Student",
    sizeClass: "large",
    provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
    generationDefaults: {},
  };
  private first!: () => void;
  private release!: () => void;
  private done!: () => void;
  readonly firstChunk = new Promise<void>((resolve) => { this.first = resolve; });
  readonly waiting = new Promise<void>((resolve) => { this.release = resolve; });
  readonly completed = new Promise<void>((resolve) => { this.done = resolve; });
  aborted = false;

  serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return {
      provider: this.student.provider.kind,
      model: this.student.provider.model,
      format: "json",
      value: JSON.stringify(fragment),
    };
  }
  continue(): void { this.release(); }
  async *stream(_input: ModelInput, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.addEventListener("abort", () => { this.aborted = true; }, { once: true });
    yield { type: "text_delta", text: "第一段" };
    this.first();
    await this.waiting;
    yield { type: "text_delta", text: "第二段" };
    yield { type: "finish", reason: "stop" };
    this.done();
  }
}

function messageTexts(updates: acp.SessionNotification[]): Array<[string, string]> {
  return updates.flatMap(({ update }) => {
    if (
      (update.sessionUpdate !== "user_message_chunk" && update.sessionUpdate !== "agent_message_chunk") ||
      update.content.type !== "text" || !update.messageId
    ) return [];
    return [[update.messageId, update.content.text] as [string, string]];
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待真实 WebSocket 更新超时");
}
