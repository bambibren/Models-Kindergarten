import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { makePromptMeta } from "@kindergarten/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KindergartenAgent } from "../src/acp/kindergarten-agent.js";
import type {
  ModelEvent,
  ModelInput,
  ModelProvider,
  ModelStudent,
} from "../src/model/model-provider.js";
import { SessionRepository } from "../src/repository/session-repository.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { FileSandbox } from "../src/tools/sandbox.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ModelProviderError } from "../src/model/model-error.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("ACP 会话语义", () => {
  it("load 完整回放，resume 零回放，且连接之间不广播", async () => {
    const agent = await makeAgent(new StaticProvider());
    const firstUpdates: acp.SessionNotification[] = [];
    const secondUpdates: acp.SessionNotification[] = [];
    const first = await openClient(agent, firstUpdates);

    // initialize 本身不应产生任何 session/update。
    expect(firstUpdates).toHaveLength(0);
    const created = await first.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    await sendPrompt(first, created.sessionId, "第一问", "turn-1");

    const second = await openClient(agent, secondUpdates);
    const firstCount = firstUpdates.length;
    await second.agent.request(acp.methods.agent.session.load, {
      sessionId: created.sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });

    expect(firstUpdates).toHaveLength(firstCount);
    expect(messageTexts(secondUpdates)).toEqual([
      [expect.any(String), "第一问"],
      [expect.any(String), "第一段第二段"],
    ]);

    secondUpdates.length = 0;
    await second.agent.request(acp.methods.agent.session.resume, {
      sessionId: created.sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });
    expect(secondUpdates).toHaveLength(0);

    firstUpdates.length = 0;
    await sendPrompt(first, created.sessionId, "第二问", "turn-2");
    expect(firstUpdates.length).toBeGreaterThan(0);
    expect(secondUpdates).toHaveLength(0);

    await closeClient(first);
    await closeClient(second);
  });

  it("同一 session 同时只允许一轮 prompt，并支持 cancel", async () => {
    const provider = new WaitingProvider();
    const agent = await makeAgent(provider);
    const updates: acp.SessionNotification[] = [];
    const client = await openClient(agent, updates);
    const created = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });

    const running = sendPrompt(
      client,
      created.sessionId,
      "等待取消",
      "turn-running",
    );
    await provider.started;

    await expect(
      sendPrompt(
        client,
        created.sessionId,
        "并发请求",
        "turn-second",
      ),
    ).rejects.toThrow("已有一轮回答正在生成");

    await client.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: created.sessionId,
    });
    await expect(running).resolves.toMatchObject({ stopReason: "cancelled" });
    await closeClient(client);
  });

  it("Prompt 致命错误只通过 JSON-RPC error 保留具体原因", async () => {
    const client = await openClient(await makeAgent(new FailedProvider()), []);
    const created = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    try {
      await sendPrompt(client, created.sessionId, "触发依赖错误", "turn-failed");
      throw new Error("预期 Prompt 失败");
    } catch (error) {
      expect(error).toBeInstanceOf(acp.RequestError);
      expect((error as acp.RequestError).code).toBe(-32001);
      expect((error as acp.RequestError).message).toContain("Ollama 不可用");
      expect((error as acp.RequestError).data).toBeUndefined();
    }
    await closeClient(client);
  });
});

class StaticProvider implements ModelProvider {
  readonly student = testStudent;
  async *stream(): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", text: "第一段" };
    yield { type: "text_delta", text: "第二段" };
    yield { type: "finish", reason: "stop" };
  }
}

class WaitingProvider implements ModelProvider {
  readonly student = testStudent;
  private start!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.start = resolve;
  });

  async *stream(
    _input: ModelInput,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    this.start();
    await new Promise<void>((_resolve, reject) => {
      const cancel = () => reject(new DOMException("已取消", "AbortError"));
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
    if (false) yield { type: "finish", reason: "cancelled" };
  }
}

class FailedProvider implements ModelProvider {
  readonly student = testStudent;
  async *stream(): AsyncIterable<ModelEvent> {
    throw new ModelProviderError("dependency_unavailable", "Ollama 不可用", true);
  }
}

async function makeAgent(provider: ModelProvider): Promise<acp.AgentApp> {
  const dir = await mkdtemp(join(tmpdir(), "kindergarten-"));
  tempDirs.push(dir);
  const sessions = new SessionRepository(dir);
  const sandbox = new FileSandbox(join(dir, "sandbox"));
  await sandbox.initialize();
  return new KindergartenAgent(
    sessions,
    AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox)),
  ).createApp();
}

async function openClient(
  agent: acp.AgentApp,
  updates: acp.SessionNotification[],
): Promise<acp.ClientConnection> {
  const app = acp
    .client({ name: "test-client" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
    });
  const connection = app.connect(agent);
  await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  return connection;
}

function sendPrompt(
  client: acp.ClientConnection,
  sessionId: string,
  text: string,
  turnId: string,
): Promise<acp.PromptResponse> {
  return client.agent.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text }],
    _meta: makePromptMeta({
      schemaVersion: 1,
      turnId,
    }),
  });
}

const testStudent: ModelStudent = {
  id: "test-student",
  name: "Test Student",
  provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
  agentConfig: { systemPrompt: "test" },
};

function messageTexts(
  updates: acp.SessionNotification[],
): Array<[string, string]> {
  return updates.flatMap((notice) => {
    const update = notice.update;
    if (
      (update.sessionUpdate !== "user_message_chunk" &&
        update.sessionUpdate !== "agent_message_chunk") ||
      update.content.type !== "text" ||
      !update.messageId
    ) {
      return [];
    }
    return [[update.messageId, update.content.text] as [string, string]];
  });
}

async function closeClient(client: acp.ClientConnection): Promise<void> {
  client.close();
  await client.closed;
}
