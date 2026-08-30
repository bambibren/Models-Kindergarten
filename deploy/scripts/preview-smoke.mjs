import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as acp from "../../apps/remote/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { createWebSocketStream } from "../../apps/remote/node_modules/@agentclientprotocol/sdk/dist/ws-stream.js";
import { internalOriginProbeSource } from "./internal-origin-probe.mjs";

const origin = process.env.MK_PREVIEW_ORIGIN ?? "http://127.0.0.1:7410";
const officeOrigin = process.env.MK_PREVIEW_OFFICE_ORIGIN ?? "http://127.0.0.1:7411";
const checks = [];

await waitFor(`${origin}/health/ready`, 90_000);
await check("Web 构建产物", async () => {
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<div id="root"><\/div>/u);
});
await check("Remote live / ready", async () => {
  assert.equal((await fetch(`${origin}/health/live`)).status, 200);
  assert.equal((await fetch(`${origin}/health/ready`)).status, 200);
});
await check("Control API 与 Evaluation 模块", async () => {
  const agents = await fetch(`${origin}/api/control/v1/agents?limit=1`, { headers: { origin } });
  assert.equal(agents.status, 200);
  const evaluation = await fetch(`${origin}/api/evaluation/v1/turn-evaluations/smoke/missing`);
  assert.equal(evaluation.status, 404);
});
await check("Skills 静态资源", async () => {
  const list = await fetch(`${origin}/skills`).then((response) => response.json());
  assert.deepEqual(list.skills.map((item) => item.name), ["pptx", "website-design-fast"]);
  for (const name of ["pptx", "website-design-fast"]) {
    const response = await fetch(`${origin}/skills/${name}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/vnd\.mk\.skill\+json/u);
    assert.equal((await response.json()).name, name);
  }
});
await check("Docker 内部服务地址", async () => {
  const facts = JSON.parse(compose("exec", "-T", "mk-app", "node", "-e", internalOriginProbeSource));
  assert.deepEqual(facts.map((item) => [item.name, item.status]), [
    ["Web Skills", 200],
    ["Runtime", 200],
    ["ONLYOFFICE", 200],
  ]);
});
await check("ACP WebSocket initialize", async () => {
  const url = new URL("/acp", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const connection = acp.client({ name: "docker-preview-smoke" }).connect(createWebSocketStream(url.toString()));
  try {
    const initialized = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    assert.equal(initialized.protocolVersion, acp.PROTOCOL_VERSION);
  } finally {
    connection.close();
    await connection.closed;
  }
});
await check("ONLYOFFICE 健康", async () => {
  const response = await fetch(`${officeOrigin}/healthcheck`);
  assert.equal(response.status, 200);
});
await check("mk-app 非 root 与主密钥权限", async () => {
  assert.equal(compose("exec", "-T", "mk-app", "id", "-u").trim(), "10001");
  const facts = JSON.parse(compose(
    "exec", "-T", "mk-app", "node", "-e",
    "const fs=require('node:fs');const s=fs.statSync('/run/secrets/mk_master_key');process.stdout.write(JSON.stringify({uid:s.uid,mode:s.mode&0o777,bytes:fs.readFileSync('/run/secrets/mk_master_key','utf8').trim().length}))",
  ));
  assert.equal(facts.uid, 10001);
  assert.equal(facts.mode, 0o600);
  assert.equal(facts.bytes, 44);
});
await check("/data 在容器重启后保持", async () => {
  const marker = randomUUID();
  compose("exec", "-T", "mk-app", "node", "-e", `require('node:fs').writeFileSync('/data/.preview-smoke','${marker}')`);
  compose("restart", "mk-app");
  await waitFor(`${origin}/health/ready`, 90_000);
  assert.equal(compose("exec", "-T", "mk-app", "node", "-e", "process.stdout.write(require('node:fs').readFileSync('/data/.preview-smoke','utf8'))"), marker);
});

console.log(`Docker 预演冒烟测试通过：${checks.join("、")}`);

async function check(name, run) {
  await run();
  checks.push(name);
  console.log(`通过：${name}`);
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`等待服务就绪超时：${url}`);
}

function compose(...args) {
  const result = spawnSync("docker", [
    "compose",
    "--env-file", "deploy/env/internal.env",
    "--env-file", "deploy/env/preview.env.example",
    "-f", "deploy/compose.yaml",
    ...args,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `docker compose ${args.join(" ")} 失败`);
  return result.stdout;
}
