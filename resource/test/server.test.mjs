import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createResourceServer, exportStaticResourceSite } from "../server.mjs";

let server;
let baseUrl;
let fixtureRoot;
let catalogFile;

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "mk-resource-test-"));
  const skill = join(fixtureRoot, "demo-skill");
  await mkdir(join(skill, "agents"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: demo-skill\ndescription: test\n---\n\n# Demo\n");
  await writeFile(join(skill, "agents", "openai.yaml"), "interface:\n  display_name: \"Demo\"\n");
  catalogFile = join(fixtureRoot, "catalog.json");
  await writeFile(catalogFile, JSON.stringify({
    schemaVersion: 1,
    skills: [{ name: "demo-skill", displayName: "示例 Skill", description: "用于验证中文市场目录。", category: "测试" }],
  }));
  server = createResourceServer({ skillsRoot: fixtureRoot, catalogFile });
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
  assert.deepEqual(list.skills, [{
    name: "demo-skill",
    url: "/skills/demo-skill",
    displayName: "示例 Skill",
    description: "用于验证中文市场目录。",
    category: "测试",
  }]);

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

test("导出 Caddy 可直接提供的静态 Skill 站点", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "mk-resource-static-"));
  try {
    const exported = await exportStaticResourceSite(fixtureRoot, outputRoot, { catalogFile });
    assert.deepEqual(exported, ["demo-skill"]);

    const list = JSON.parse(await readFile(join(outputRoot, "skills", "index.json"), "utf8"));
    assert.equal(list.skills[0].displayName, "示例 Skill");
    assert.equal(list.skills[0].description, "用于验证中文市场目录。");

    const bundle = JSON.parse(await readFile(join(outputRoot, "skills", "demo-skill.json"), "utf8"));
    assert.equal(bundle.kind, "mk-skill-bundle");
    assert.equal(bundle.name, "demo-skill");
    assert.equal(bundle.contentHash.length, 64);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("中文目录必须与实际 Skill 集合完全一致", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "mk-resource-catalog-mismatch-"));
  const mismatch = join(fixtureRoot, "catalog-mismatch.json");
  try {
    await writeFile(mismatch, JSON.stringify({
      schemaVersion: 1,
      skills: [{ name: "other-skill", displayName: "其他", description: "不对应实际资源。", category: "测试" }],
    }));
    await assert.rejects(
      exportStaticResourceSite(fixtureRoot, outputRoot, { catalogFile: mismatch }),
      /中文目录与资源集合不匹配/u,
    );
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    await rm(mismatch, { force: true });
  }
});
