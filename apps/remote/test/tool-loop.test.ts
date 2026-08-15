import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { TURN_STATE_NOTIFICATION, makePromptMeta, makeSessionBindingMeta, readTurnStateNotification, type TurnState } from "@kindergarten/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KindergartenAgent } from "../src/acp/kindergarten-agent.js";
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
import { FileSandbox } from "../src/tools/sandbox.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { SessionBindingService } from "../src/session/session-binding-service.js";

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
    const sessions = new SessionRepository(join(dir, "data"));
    const agent = new KindergartenAgent(
      sessions,
      AgentRuntime.fromRegistry(new ScriptedToolProvider(), new ToolRegistry(sandbox)),
      testBindings(),
    ).createApp();

    const updates: acp.SessionNotification[] = [];
    const permissions: acp.RequestPermissionRequest[] = [];
    const questions: acp.CreateElicitationRequest[] = [];
    const turnStates: TurnState[] = [];
    const clientApp = acp
      .client({ name: "tool-test-client" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      })
      .onNotification(TURN_STATE_NOTIFICATION, { parse: readTurnStateNotification }, ({ params }) => {
        turnStates.push(params.turn);
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
      _meta: makeSessionBindingMeta({ schemaVersion: 1, modelStudentId: "student-1", agentId: "agent-1" }),
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
    expect(turnStates).toContainEqual(expect.objectContaining({ status: "active", phase: "preparing_context" }));
    expect(turnStates).toContainEqual(expect.objectContaining({ status: "active", phase: "model_streaming" }));
    expect(turnStates).toContainEqual(expect.objectContaining({ status: "active", phase: "tool_execution" }));
    expect(turnStates.at(-1)).toEqual({ schemaVersion: 1, turnId: "tool-turn", status: "completed" });
    expect((await sessions.get(session.sessionId)).turns[0]).toMatchObject({
      state: { status: "completed" },
      stopReason: "end_turn",
    });

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

function testBindings(): SessionBindingService {
  return new SessionBindingService({
    workspaceCwd: "/workspace",
    agentExists: (id) => id === "agent-1",
    modelStudentReady: (id) => id === "student-1",
    experimentBinding: async () => undefined,
  });
}

class ScriptedToolProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "tool-fixture",
    name: "Tool Fixture",
    sizeClass: "large",
    provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
    generationDefaults: {},
  };
  serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    const value = fragment.kind === "system"
      ? { role: "system", content: fragment.content }
      : fragment.kind === "tools"
        ? fragment.tools
        : fragment.kind === "messages"
          ? fragment.messages
          : { sent: false, sourceIds: fragment.sourceIds };
    return {
      provider: this.student.provider.kind,
      model: this.student.provider.model,
      format: "json",
      value: JSON.stringify(value, null, 2),
    };
  }

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
