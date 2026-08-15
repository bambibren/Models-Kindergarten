import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import {
  makePromptMeta,
  makeSessionBindingMeta,
  type ConcreteReasoningProfile,
} from "@kindergarten/contracts";

const FIXED_PROMPT = `请先调用 ensure_agent_skills，把以下 4 个 Skills 安装到当前 Agent 并自动启用，全部就绪后再开始任务：
https://github.com/anthropics/skills/tree/main/skills/frontend-design
https://github.com/nexu-io/open-design/tree/main/skills/design-brief
https://github.com/nexu-io/open-design/tree/main/skills/impeccable-design-polish
https://github.com/greensock/gsap-skills.git

请制作一个气泡水网站，风格是幼稚可爱清新活泼，气泡水有四种口味：葡萄、橙子、海盐、青柠。首屏的大slogan是“快来一起做汽水课间操！”，背景需要有淡化不喧宾夺主的动效。然后后面几屏需要展示不同口味气泡水瓶的介绍，需要气泡水瓶内的水随鼠标反馈可以做液体运动。还需要展示网页互动小游戏，吸引学生群体。`;

const modelStudentId = requiredArgument("--model");
const agentId = requiredArgument("--agent");
const profile = concreteProfile(requiredArgument("--profile"));
const remoteUrl = argument("--remote") ?? "ws://127.0.0.1:7331/acp";

const app = acp.client({ name: "models-kindergarten-skill-context-matrix" })
  .onNotification(acp.methods.client.session.update, () => {})
  .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
    const option = params.options.find((item) => item.kind === "allow_once");
    if (!option) return { outcome: { outcome: "cancelled" as const } };
    return { outcome: { outcome: "selected" as const, optionId: option.optionId } };
  })
  .onRequest(acp.methods.client.elicitation.create, async () => ({ action: "cancel" as const }));

const connection = app.connect(createWebSocketStream(remoteUrl));
try {
  await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      elicitation: { form: {} },
      session: { configOptions: {} },
    },
    clientInfo: {
      name: "models-kindergarten-skill-context-matrix",
      version: "0.1.0",
    },
  });
  const created = await connection.agent.request(acp.methods.agent.session.new, {
    cwd: "/workspace",
    mcpServers: [],
    _meta: makeSessionBindingMeta({
      schemaVersion: 1,
      modelStudentId,
      agentId,
    }),
  });
  await connection.agent.request(acp.methods.agent.session.setConfigOption, {
    sessionId: created.sessionId,
    configId: "reasoning_profile",
    value: profile,
  });
  const turnId = randomUUID();
  const response = await connection.agent.request(acp.methods.agent.session.prompt, {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: FIXED_PROMPT }],
    _meta: makePromptMeta({ schemaVersion: 1, turnId }),
  });
  process.stdout.write(`${JSON.stringify({
    sessionId: created.sessionId,
    turnId,
    modelStudentId,
    profile,
    stopReason: response.stopReason,
  })}\n`);
} finally {
  connection.close();
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}

function concreteProfile(value: string): ConcreteReasoningProfile {
  if (value === "fast" || value === "balanced" || value === "deep" || value === "max") return value;
  throw new Error(`不支持的测试档位: ${value}`);
}
