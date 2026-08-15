import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicJsonStore } from "../../src/storage/atomic-json-store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AtomicJsonStore", () => {
  it("串行提交并保留上一份可读备份", async () => {
    const dir = await tempDir();
    const file = join(dir, "records.json");
    const store = new AtomicJsonStore<{ id: string; value: number }>({
      file,
      schemaVersion: 1,
      validate: isRecord,
    });

    await Promise.all([
      store.update((records) => [...records, { id: "a", value: 1 }]),
      store.update((records) => [...records, { id: "b", value: 2 }]),
    ]);
    expect(await store.read()).toEqual([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ]);

    await store.update((records) => records.map((item) => ({ ...item, value: item.value + 1 })));
    const backup = JSON.parse(await readFile(`${file}.bak`, "utf8")) as { records: unknown[] };
    expect(backup.records).toHaveLength(2);
    expect(backup.records[0]).toEqual({ id: "a", value: 1 });
  });

  it("主文件损坏时从备份恢复；两份都损坏则停止写入", async () => {
    const dir = await tempDir();
    const file = join(dir, "records.json");
    const create = () => new AtomicJsonStore<{ id: string; value: number }>({
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

  it("schemaVersion 或 record 非法时拒绝读取", async () => {
    const dir = await tempDir();
    const file = join(dir, "records.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 2, records: [] }), "utf8");
    const store = new AtomicJsonStore<{ id: string; value: number }>({ file, schemaVersion: 1, validate: isRecord });
    await expect(store.read()).rejects.toThrow("schemaVersion");
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mk-store-"));
  dirs.push(dir);
  return dir;
}

function isRecord(value: unknown): value is { id: string; value: number } {
  return typeof value === "object" && value !== null && "id" in value && "value" in value &&
    typeof value.id === "string" && typeof value.value === "number";
}
