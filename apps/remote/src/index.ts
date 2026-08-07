import { resolve } from "node:path";
import { KindergartenAgent } from "./acp/kindergarten-agent.js";
import { OllamaProvider } from "./model/ollama-provider.js";
import type { ModelStudent } from "./model/model-provider.js";
import { SessionRepository } from "./repository/session-repository.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";
import { RemoteServer } from "./server/http-server.js";
import { FileSandbox } from "./tools/sandbox.js";
import { ToolRegistry } from "./tools/tool-registry.js";

const port = integerEnv("PORT", 7331);
const host = process.env.HOST ?? "127.0.0.1";
const dataDir = resolve(process.env.DATA_DIR ?? ".data");
const sandboxDir = resolve(process.env.SANDBOX_DIR ?? `${dataDir}/sandbox`);
const student = createStudent();
const model = new OllamaProvider(student);

// Remote 即使在 Ollama 暂不可用时也保持 ACP 可连接，具体依赖错误在 Prompt 边界结构化返回。
try {
  await model.verify();
} catch (error) {
  console.warn(`ModelStudent 暂不可用：${error instanceof Error ? error.message : String(error)}`);
}

const sessions = new SessionRepository(dataDir);
const sandbox = new FileSandbox(sandboxDir);
await sandbox.initialize();
const runtime = AgentRuntime.fromRegistry(model, new ToolRegistry(sandbox));
const agent = new KindergartenAgent(sessions, runtime).createApp();
const server = new RemoteServer(agent, {
  studentId: student.id,
  studentName: student.name,
  provider: student.provider.kind,
  model: student.provider.model,
});

await server.listen(host, port);
console.log(`Kindergarten Remote: ws://${host}:${port}/acp`);
console.log(`ModelStudent: ${student.name} (${student.provider.model})`);
console.log(`Sandbox: ${sandbox.root}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}

function createStudent(): ModelStudent {
  const provider = process.env.MODEL_PROVIDER ?? "ollama";
  if (provider !== "ollama") {
    throw new Error(
      `V1.5 只实现 ollama Provider；${provider} 仅保留在 ModelProvider 适配接口中`,
    );
  }
  return {
    id: process.env.MODEL_STUDENT_ID ?? "local-coder-student",
    name: process.env.MODEL_STUDENT_NAME ?? "本地编程小模型",
    provider: {
      kind: "ollama",
      baseUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
      model: process.env.OLLAMA_MODEL ?? "qwen3:8b",
    },
    agentConfig: {
      systemPrompt:
        process.env.AGENT_SYSTEM_PROMPT ??
        "你是 Models Kindergarten 中的本地 8B ModelStudent。请使用简洁、清楚的中文回答。你可以使用 list_files、read_file、write_file、run_command、web_search、web_fetch 和 ask_user。工具返回 ok=true 表示操作已经成功，不得用相同参数重复调用；工具返回 ok=false 时也不得原样重复调用。文件和终端只作用于隔离沙箱，终端每次都需要用户授权。",
      temperature: numberEnv("MODEL_TEMPERATURE", 0.4),
    },
  };
}

function integerEnv(name: string, fallback: number): number {
  const value = numberEnv(name, fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} 必须是非负数`);
  }
  return value;
}
