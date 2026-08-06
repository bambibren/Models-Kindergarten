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
import { SessionRepository } from "../src/repository/session-repository.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { RemoteServer } from "../src/server/http-server.js";
import { FileSandbox } from "../src/tools/sandbox.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

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
    const runtime = new AgentRuntime(
      new FixtureProvider(),
      new ToolRegistry(sandbox),
    );
    const agent = new KindergartenAgent(sessions, runtime).createApp();
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
});

function isAssistantText(notice: acp.SessionNotification): boolean {
  const update = notice.update;
  return (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content.type === "text" &&
    update.content.text.length > 0
  );
}
