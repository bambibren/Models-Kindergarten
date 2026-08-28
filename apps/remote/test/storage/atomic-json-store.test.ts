import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicJsonStore } from "../../src/storage/atomic-json-store.js";

const dirs: string[] = [];

afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => {
  await Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true })));
});

describe("AtomicJsonStore", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("串行提交并保留上一份可读备份", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await tempDir();
    const file = join(dir, "records.json");
    const store = new AtomicJsonStore<{ id: string; value: number }>({
      file,
      schemaVersion: 1,
      validate: isRecord,
    });

    await Promise.all([
      store.update(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(records) => [...records, { id: "a", value: 1 }]),
      store.update(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(records) => [...records, { id: "b", value: 2 }]),
    ]);
    expect(await store.read()).toEqual([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ]);

    await store.update(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(records) => records.map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(item) => ({ ...item, value: item.value + 1 })));
    const backup = JSON.parse(await readFile(`${file}.bak`, "utf8")) as { records: unknown[] };
    expect(backup.records).toHaveLength(2);
    expect(backup.records[0]).toEqual({ id: "a", value: 1 });
  });

  it("主文件损坏时从备份恢复；两份都损坏则停止写入", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await tempDir();
    const file = join(dir, "records.json");
    const create = /** 构造「create」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => new AtomicJsonStore<{ id: string; value: number }>({
      file,
      schemaVersion: 1,
      validate: isRecord,
    });
    const store = create();
    await store.replace([{ id: "safe", value: 1 }]);
    await store.replace([{ id: "new", value: 2 }]);
    await writeFile(file, "{broken", "utf8");

    expect(await create().read()).toEqual([{ id: "safe", value: 1 }]);
    await writeFile(file, "{broken-again", "utf8");
    await writeFile(`${file}.bak`, "{also-broken", "utf8");
    await expect(create().replace([])).rejects.toThrow("主文件和备份都不可读");
  });

  it("schemaVersion 或 record 非法时拒绝读取", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await tempDir();
    const file = join(dir, "records.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 2, records: [] }), "utf8");
    const store = new AtomicJsonStore<{ id: string; value: number }>({ file, schemaVersion: 1, validate: isRecord });
    await expect(store.read()).rejects.toThrow("schemaVersion");
  });
});

/** 构造「tempDir」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mk-store-"));
  dirs.push(dir);
  return dir;
}

/** 构造「isRecord」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function isRecord(value: unknown): value is { id: string; value: number } {
  return typeof value === "object" && value !== null && "id" in value && "value" in value &&
    typeof value.id === "string" && typeof value.value === "number";
}
