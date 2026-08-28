import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillInstaller } from "../../src/skills/skill-installer.js";
import { SkillLockStore } from "../../src/skills/skill-lock-store.js";

const dirs: string[] = [];
const resourceUrl = "http://127.0.0.1:7342/skills/demo-skill";

afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("Skill resource bundle", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("校验逐文件与整包哈希后通过现有 Installer 发布", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const root = await mkdtemp(join(tmpdir(), "mk-resource-installer-"));
    dirs.push(root);
    const bundle = makeBundle({
      "SKILL.md": "---\nname: demo-skill\ndescription: demo\n---\n\n# Demo\n",
      "agents/openai.yaml": "interface:\n  display_name: \"Demo\"\n",
    });
    const fetchImpl = vi.fn(/** 构造「fetchImpl」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => new Response(JSON.stringify(bundle), {
      headers: { "content-type": "application/vnd.mk.skill+json" },
    }));
    const installer = new SkillInstaller(join(root, "skills"), new SkillLockStore(join(root, "lock.json")), fetchImpl);

    const installed = await installer.install({ approved: true, source: { kind: "resource", url: resourceUrl } });

    expect(installed.name).toBe("demo-skill");
    expect(installed.source).toEqual({ kind: "resource", url: resourceUrl, contentHash: bundle.contentHash });
    expect(await readFile(join(root, "skills", "demo-skill", "SKILL.md"), "utf8")).toContain("name: demo-skill");
  });

  it("拒绝路径越界的资源包", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const root = await mkdtemp(join(tmpdir(), "mk-resource-invalid-"));
    dirs.push(root);
    const bundle = makeBundle({ "../escape": "bad", "SKILL.md": "---\nname: demo-skill\ndescription: demo\n---\nbody" });
    const fetchImpl = vi.fn(/** 构造「fetchImpl」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => new Response(JSON.stringify(bundle), {
      headers: { "content-type": "application/json" },
    }));
    const installer = new SkillInstaller(join(root, "skills"), new SkillLockStore(join(root, "lock.json")), fetchImpl);

    await expect(installer.install({ approved: true, source: { kind: "resource", url: resourceUrl } }))
      .rejects.toThrow("文件路径越界");
  });

  it("拒绝文件内容被篡改的资源包", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const root = await mkdtemp(join(tmpdir(), "mk-resource-tampered-"));
    dirs.push(root);
    const bundle = makeBundle({ "SKILL.md": "---\nname: demo-skill\ndescription: demo\n---\nbody" });
    bundle.files[0]!.content = Buffer.from("tampered").toString("base64");
    bundle.files[0]!.byteLength = Buffer.byteLength("tampered");
    const fetchImpl = vi.fn(/** 构造「fetchImpl」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => new Response(JSON.stringify(bundle), {
      headers: { "content-type": "application/json" },
    }));
    const installer = new SkillInstaller(join(root, "skills"), new SkillLockStore(join(root, "lock.json")), fetchImpl);

    await expect(installer.install({ approved: true, source: { kind: "resource", url: resourceUrl } }))
      .rejects.toThrow("SHA-256 不匹配");
  });
});

/** 构造「makeBundle」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function makeBundle(files: Record<string, string>) {
  const items = Object.entries(files).map(/** 构造「toSorted」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
([path, text]) => {
    const content = Buffer.from(text);
    return {
      path,
      encoding: "base64" as const,
      byteLength: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      content: content.toString("base64"),
      bytes: content,
    };
  }).toSorted(/** 构造「items」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");
  items.forEach(/** 构造「makeBundle」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => hash.update(item.path).update("\0").update(item.bytes).update("\0"));
  return {
    schemaVersion: 1 as const,
    kind: "mk-skill-bundle" as const,
    name: "demo-skill",
    contentHash: hash.digest("hex"),
    files: items.map(/** 构造「files」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ bytes: _bytes, ...item }) => item),
  };
}
