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
  PRODUCT_CONFIG,
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

afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => {
  client?.close();
  await client?.closed;
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  client = undefined;
  server = undefined;
  dir = "";
});

describe("ACP WebSocket", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("通过真实 WebSocket 完成 initialize/new/prompt", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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
      agentExists: /** 构造「agentExists」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(id) => id === "agent-1",
      modelStudentReady: /** 构造「modelStudentReady」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(id) => id === "student-1",
      experimentBinding: /** 构造「experimentBinding」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
    });
    const agent = new KindergartenAgent(sessions, runtime, bindings).createApp();
    server = new RemoteServer(agent);
    await server.listen("127.0.0.1", 0);

    const address = server.http.address() as AddressInfo;
    expect((await fetch(`http://127.0.0.1:${address.port}/health/live`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${address.port}/health/ready`)).status).toBe(200);
    const updates: acp.SessionNotification[] = [];
    const app = acp
      .client({ name: "websocket-test" })
      .onNotification(acp.methods.client.session.update, /** 构造「app」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
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

  it("ACP WebSocket 达到连接上限后在 upgrade 阶段返回 503", /** 验证空闲连接也受进程容量约束，不会无限创建 ACP 对象。 */
async () => {
    dir = await mkdtemp(join(tmpdir(), "kindergarten-ws-capacity-"));
    const sessions = new SessionRepository(dir);
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const bindings = new SessionBindingService({
      workspaceCwd: "/workspace",
      agentExists: /** 固定提供测试 Agent，连接本身不需要创建 Session。 */
(id) => id === "agent-1",
      modelStudentReady: /** 固定提供测试模型，连接本身不触发 Provider。 */
(id) => id === "student-1",
      experimentBinding: /** 此容量场景不绑定实验。 */
async () => undefined,
    });
    server = new RemoteServer(new KindergartenAgent(
      sessions,
      AgentRuntime.fromRegistry(new FixtureProvider(), new ToolRegistry(sandbox)),
      bindings,
    ).createApp());
    await server.listen("127.0.0.1", 0);
    const address = server.http.address() as AddressInfo;
    const url = `ws://127.0.0.1:${address.port}/acp`;
    const sockets: WebSocket[] = [];
    try {
      for (let index = 0; index < PRODUCT_CONFIG.server.maxAcpConnections; index += 1) {
        sockets.push(await openRawWebSocket(url));
      }
      const status = await rejectedWebSocketStatus(url);
      expect(status).toBe(503);
    } finally {
      await Promise.all(sockets.map(closeRawWebSocket));
    }
  });

  it("真实 WebSocket 断开后 Runtime 继续，手动 resume 补齐缺失输出", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    dir = await mkdtemp(join(tmpdir(), "kindergarten-ws-resume-"));
    const sessions = new SessionRepository(dir);
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const provider = new DisconnectProvider();
    const bindings = new SessionBindingService({
      workspaceCwd: "/workspace",
      agentExists: /** 构造「agentExists」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(id) => id === "agent-1",
      modelStudentReady: /** 构造「modelStudentReady」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(id) => id === "student-1",
      experimentBinding: /** 构造「experimentBinding」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
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
    }).then(/** 构造「running」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(value) => value, /** 构造「running」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(error: unknown) => error);
    await provider.firstChunk;
    await waitUntil(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
() => messageTexts(firstUpdates).some(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
([, text]) => text === "第一段"));
    const received = messageTexts(firstUpdates);
    const user = received.find(/** 构造「user」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
([, text]) => text === "真实断线")!;
    const assistant = received.find(/** 构造「assistant」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
([, text]) => text === "第一段")!;

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
    await waitUntil(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
() => resumedStates.some(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(item) => item.turn.status === "completed"));
    expect(resumedStates.at(-1)?.turn.status).toBe("completed");
  });
});

/** 建立一条不发送 ACP 请求的原始连接，用来占用网络壳连接名额。 */
function openRawWebSocket(url: string): Promise<WebSocket> {
  return new Promise(/** 将 open/error 事件收敛成一次 Promise 结算。 */
(resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", /** 返回已经进入 WebSocketServer clients 集合的连接。 */
() => resolve(socket));
    socket.once("error", reject);
  });
}

/** 读取 upgrade 被拒绝时的 HTTP 状态，并主动销毁响应流。 */
function rejectedWebSocketStatus(url: string): Promise<number> {
  return new Promise(/** overflow 连接不能进入 open 状态，只接受明确 HTTP 拒绝。 */
(resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("unexpected-response", /** 记录拒绝状态并关闭底层响应，避免测试遗留 socket。 */
(_request, response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      resolve(status);
    });
    socket.once("open", /** 超限连接若意外成功，立即关闭并让测试失败。 */
() => { socket.close(); reject(new Error("超限 WebSocket 不应连接成功")); });
    socket.once("error", /** unexpected-response 后的派生错误无需重复结算。 */
(error) => { if (socket.readyState !== WebSocket.CLOSED) reject(error); });
  });
}

/** 关闭原始连接并等待 close，保证 Server.close 不被测试资源阻塞。 */
function closeRawWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise(/** 把 WebSocket close 事件转换为可等待清理步骤。 */
(resolve) => { socket.once("close", resolve); socket.close(); });
}

/** 构造「isAssistantText」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function isAssistantText(notice: acp.SessionNotification): boolean {
  const update = notice.update;
  return (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content.type === "text" &&
    update.content.text.length > 0
  );
}

/** 构造「openWebSocketClient」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function openWebSocketClient(
  port: number,
  updates: acp.SessionNotification[],
  turns: TurnStateNotification[] = [],
): Promise<acp.ClientConnection> {
  const app = acp
    .client({ name: "websocket-resume-test" })
    .onNotification(acp.methods.client.session.update, /** 构造「onNotification」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => { updates.push(params); })
    .onNotification(TURN_STATE_NOTIFICATION, readTurnStateNotification, /** 构造「app」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => { turns.push(params); });
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
  readonly firstChunk = new Promise<void>(/** 构造「firstChunk」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resolve) => { this.first = resolve; });
  readonly waiting = new Promise<void>(/** 构造「waiting」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resolve) => { this.release = resolve; });
  readonly completed = new Promise<void>(/** 构造「completed」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resolve) => { this.done = resolve; });
  aborted = false;

  /** 构造「serializeContext」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return {
      provider: this.student.provider.kind,
      model: this.student.provider.model,
      format: "json",
      value: JSON.stringify(fragment),
    };
  }
  /** 构造「continue」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
continue(): void { this.release(); }
  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async *stream(_input: ModelInput, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.addEventListener("abort", /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => { this.aborted = true; }, { once: true });
    yield { type: "text_delta", text: "第一段" };
    this.first();
    await this.waiting;
    yield { type: "text_delta", text: "第二段" };
    yield { type: "finish", reason: "stop" };
    this.done();
  }
}

/** 构造「messageTexts」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function messageTexts(updates: acp.SessionNotification[]): Array<[string, string]> {
  return updates.flatMap(/** 构造「messageTexts」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ update }) => {
    if (
      (update.sessionUpdate !== "user_message_chunk" && update.sessionUpdate !== "agent_message_chunk") ||
      update.content.type !== "text" || !update.messageId
    ) return [];
    return [[update.messageId, update.content.text] as [string, string]];
  });
}

/** 构造「waitUntil」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待真实 WebSocket 更新超时");
}
