import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createResourceServer } from "../server.mjs";

let server;
let baseUrl;
let fixtureRoot;

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "mk-resource-test-"));
  const skill = join(fixtureRoot, "demo-skill");
  await mkdir(join(skill, "agents"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: demo-skill\ndescription: test\n---\n\n# Demo\n");
  await writeFile(join(skill, "agents", "openai.yaml"), "interface:\n  display_name: \"Demo\"\n");
  server = createResourceServer({ skillsRoot: fixtureRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(fixtureRoot, { recursive: true, force: true });
});

test("列出并下载带哈希的 Skill bundle", async () => {
  const list = await fetch(`${baseUrl}/skills`).then((response) => response.json());
  assert.deepEqual(list.skills, [{ name: "demo-skill", url: "/skills/demo-skill" }]);

  const response = await fetch(`${baseUrl}/skills/demo-skill`);
  assert.equal(response.headers.get("content-type"), "application/vnd.mk.skill+json; charset=utf-8");
  const bundle = await response.json();
  assert.equal(bundle.kind, "mk-skill-bundle");
  assert.equal(bundle.name, "demo-skill");
  assert.equal(bundle.contentHash.length, 64);
  assert.deepEqual(bundle.files.map((file) => file.path), ["agents/openai.yaml", "SKILL.md"]);
  const instructions = bundle.files.find((file) => file.path === "SKILL.md");
  assert.equal(Buffer.from(instructions.content, "base64").toString("utf8").includes("name: demo-skill"), true);
});
