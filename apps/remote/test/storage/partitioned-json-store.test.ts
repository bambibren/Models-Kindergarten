import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PartitionedJsonStore } from "../../src/storage/partitioned-json-store.js";

interface FixtureRecord { id: string; payload: string }

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("PartitionedJsonStore", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("把旧聚合文件迁移为按 ID 分片，并让定向读取不依赖无关分片", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-partitioned-store-"));
    dirs.push(dir);
    const legacyFile = join(dir, "records.json");
    await writeFile(legacyFile, JSON.stringify({
      schemaVersion: 1,
      records: [{ id: "one", payload: "一" }, { id: "two", payload: "二" }],
    }), "utf8");
    const store = fixtureStore(legacyFile);

    expect(await store.get("one")).toEqual({ id: "one", payload: "一" });
    expect(JSON.parse(await readFile(join(dir, "records", "index.json"), "utf8"))).toMatchObject({ ids: ["one", "two"] });
    expect(await readFile(`${legacyFile}.v1.bak`, "utf8")).toContain('"payload":"一"');

    // 损坏无关 ID 后，按 ID 读取 one 仍成功，证明普通 get 没有解析全部记录。
    const other = join(dir, "records", "records", `${digest("two")}.json`);
    await writeFile(other, "{broken", "utf8");
    expect(await store.get("one")).toEqual({ id: "one", payload: "一" });
    await expect(store.get("two")).rejects.toThrow();
  });

  it("单条更新保留备份且不能改变领域 ID", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-partitioned-store-"));
    dirs.push(dir);
    const legacyFile = join(dir, "records.json");
    const store = fixtureStore(legacyFile);
    await store.insert({ id: "one", payload: "旧值" });
    await store.update("one", /** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(value) => ({ ...value, payload: "新值" }));
    expect(await store.get("one")).toEqual({ id: "one", payload: "新值" });
    expect(await readFile(join(dir, "records", "records", `${digest("one")}.json.bak`), "utf8")).toContain("旧值");
    await expect(store.update("one", /** 构造「rejects」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => ({ id: "changed", payload: "非法" }))).rejects.toThrow("不能改变记录 ID");
  });
});

/** 为测试创建最小领域 Store。 */
function fixtureStore(legacyFile: string): PartitionedJsonStore<FixtureRecord> {
  return new PartitionedJsonStore({
    legacyFile,
    recordSchemaVersion: 1,
    idOf: /** 构造「idOf」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(value) => value.id,
    validate: /** 构造「validate」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(value): value is FixtureRecord =>
      typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" &&
      "payload" in value && typeof value.payload === "string",
  });
}

/** 复现 Store 的安全文件名映射。 */
function digest(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}
