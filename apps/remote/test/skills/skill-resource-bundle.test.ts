import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillInstaller } from "../../src/skills/skill-installer.js";
import { SkillLockStore } from "../../src/skills/skill-lock-store.js";

const dirs: string[] = [];
const resourceUrl = "http://127.0.0.1:7342/skills/demo-skill";

afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("Skill resource bundle", () => {
  it("校验逐文件与整包哈希后通过现有 Installer 发布", async () => {
    const root = await mkdtemp(join(tmpdir(), "mk-resource-installer-"));
    dirs.push(root);
    const bundle = makeBundle({
      "SKILL.md": "---\nname: demo-skill\ndescription: demo\n---\n\n# Demo\n",
      "agents/openai.yaml": "interface:\n  display_name: \"Demo\"\n",
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(bundle), {
      headers: { "content-type": "application/vnd.mk.skill+json" },
    }));
    const installer = new SkillInstaller(join(root, "skills"), new SkillLockStore(join(root, "lock.json")), fetchImpl);

    const installed = await installer.install({ approved: true, source: { kind: "resource", url: resourceUrl } });

    expect(installed.name).toBe("demo-skill");
    expect(installed.source).toEqual({ kind: "resource", url: resourceUrl, contentHash: bundle.contentHash });
    expect(await readFile(join(root, "skills", "demo-skill", "SKILL.md"), "utf8")).toContain("name: demo-skill");
  });

  it("拒绝路径越界的资源包", async () => {
    const root = await mkdtemp(join(tmpdir(), "mk-resource-invalid-"));
    dirs.push(root);
    const bundle = makeBundle({ "../escape": "bad", "SKILL.md": "---\nname: demo-skill\ndescription: demo\n---\nbody" });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(bundle), {
      headers: { "content-type": "application/json" },
    }));
    const installer = new SkillInstaller(join(root, "skills"), new SkillLockStore(join(root, "lock.json")), fetchImpl);

    await expect(installer.install({ approved: true, source: { kind: "resource", url: resourceUrl } }))
      .rejects.toThrow("文件路径越界");
  });

  it("拒绝文件内容被篡改的资源包", async () => {
    const root = await mkdtemp(join(tmpdir(), "mk-resource-tampered-"));
    dirs.push(root);
    const bundle = makeBundle({ "SKILL.md": "---\nname: demo-skill\ndescription: demo\n---\nbody" });
    bundle.files[0]!.content = Buffer.from("tampered").toString("base64");
    bundle.files[0]!.byteLength = Buffer.byteLength("tampered");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(bundle), {
      headers: { "content-type": "application/json" },
    }));
    const installer = new SkillInstaller(join(root, "skills"), new SkillLockStore(join(root, "lock.json")), fetchImpl);

    await expect(installer.install({ approved: true, source: { kind: "resource", url: resourceUrl } }))
      .rejects.toThrow("SHA-256 不匹配");
  });
});

function makeBundle(files: Record<string, string>) {
  const items = Object.entries(files).map(([path, text]) => {
    const content = Buffer.from(text);
    return {
      path,
      encoding: "base64" as const,
      byteLength: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      content: content.toString("base64"),
      bytes: content,
    };
  }).toSorted((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");
  items.forEach((item) => hash.update(item.path).update("\0").update(item.bytes).update("\0"));
  return {
    schemaVersion: 1 as const,
    kind: "mk-skill-bundle" as const,
    name: "demo-skill",
    contentHash: hash.digest("hex"),
    files: items.map(({ bytes: _bytes, ...item }) => item),
  };
}
