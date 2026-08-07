import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Tool Loop", () => {
  it("写入授权、AskUser、读取和历史回放形成完整 ACP 闭环", async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const agent = new KindergartenAgent(
      new SessionRepository(join(dir, "data")),
      AgentRuntime.fromRegistry(new ScriptedToolProvider(), new ToolRegistry(sandbox)),
    ).createApp();

    const updates: acp.SessionNotification[] = [];
    const permissions: acp.RequestPermissionRequest[] = [];
    const questions: acp.CreateElicitationRequest[] = [];
    const clientApp = acp
      .client({ name: "tool-test-client" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissions.push(params);
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      })
      .onRequest(acp.methods.client.elicitation.create, ({ params }) => {
        questions.push(params);
        return { action: "accept", content: { answer: "蓝色" } };
      });
    const client = clientApp.connect(agent);
    await client.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const session = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });

    const response = await client.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "完成工具测试" }],
      _meta: makePromptMeta({ schemaVersion: 1, turnId: "tool-turn" }),
    });

    expect(response.stopReason).toBe("end_turn");
    expect(permissions).toHaveLength(1);
    expect(questions).toHaveLength(1);
    expect(await readFile(join(dir, "sandbox", "notes", "answer.txt"), "utf8"))
      .toBe("初始内容");

    const starts = updates.flatMap((notice) =>
      notice.update.sessionUpdate === "tool_call" ? [notice.update] : [],
    );
    expect(starts.map((item) => item.name)).toEqual([
      "write_file",
      "ask_user",
      "read_file",
    ]);
    expect(updates.filter((notice) =>
      notice.update.sessionUpdate === "tool_call_update" &&
      notice.update.status === "completed",
    )).toHaveLength(3);

    updates.length = 0;
    await client.agent.request(acp.methods.agent.session.load, {
      sessionId: session.sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });
    const replayedTools = updates.flatMap((notice) =>
      notice.update.sessionUpdate === "tool_call" ? [notice.update] : [],
    );
    expect(replayedTools).toHaveLength(3);
    expect(replayedTools.every((item) => item.status === "completed")).toBe(true);

    client.close();
    await client.closed;
  });

  it("拒绝绝对路径和父目录穿越", async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    await expect(sandbox.readText("../secret.txt")).rejects.toThrow("path");
    await expect(sandbox.writeText("/tmp/escape.txt", "no"))
      .rejects.toThrow("相对");
  });
});

class ScriptedToolProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "tool-fixture",
    name: "Tool Fixture",
    provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
    agentConfig: { systemPrompt: "test" },
  };

  async *stream(input: ModelInput): AsyncIterable<ModelEvent> {
    const results = input.messages.filter((item) => item.role === "tool");
    if (results.length === 0) {
      yield {
        type: "tool_calls",
        calls: [
          {
            id: "ollama-write",
            name: "write_file",
            arguments: { path: "notes/answer.txt", content: "初始内容" },
          },
          {
            id: "ollama-ask",
            name: "ask_user",
            arguments: { question: "你喜欢什么颜色？" },
          },
        ],
      };
    } else if (results.length === 2) {
      yield {
        type: "tool_calls",
        calls: [{
          id: "ollama-read",
          name: "read_file",
          arguments: { path: "notes/answer.txt" },
        }],
      };
    } else {
      yield { type: "text_delta", text: "工具链已完成" };
    }
    yield { type: "finish", reason: "stop" };
  }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kindergarten-tools-"));
  tempDirs.push(dir);
  return dir;
}
