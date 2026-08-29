import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileMasterKeySource, initializeMasterKey } from "../../src/secrets/file-master-key.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileMasterKeySource", () => {
  it("只读取权限收紧的 32 字节 base64 普通文件", async () => {
    const dir = await tempDir();
    const file = join(dir, "master-key");
    const expected = Buffer.alloc(32, 7);
    await writeFile(file, `${expected.toString("base64")}\n`, { mode: 0o600 });

    await expect(new FileMasterKeySource(file).read()).resolves.toEqual(expected);

    await writeFile(file, "not-a-key\n", { mode: 0o600 });
    await expect(new FileMasterKeySource(file).read()).rejects.toThrow("32 字节 base64");
  });

  it("拒绝组/其他用户可读和符号链接主密钥", async () => {
    const dir = await tempDir();
    const target = join(dir, "target");
    const link = join(dir, "link");
    await writeFile(target, `${Buffer.alloc(32, 1).toString("base64")}\n`, { mode: 0o644 });
    await expect(new FileMasterKeySource(target).read()).rejects.toThrow("0400 或 0600");

    await symlink(target, link);
    await expect(new FileMasterKeySource(link).read()).rejects.toThrow("普通文件");
  });

  it("接受容器只读挂载常用的 0400 主密钥", async () => {
    const dir = await tempDir();
    const file = join(dir, "master-key-readonly");
    const expected = Buffer.alloc(32, 5);
    await writeFile(file, `${expected.toString("base64")}\n`, { mode: 0o400 });

    await expect(new FileMasterKeySource(file).read()).resolves.toEqual(expected);
  });

  it("初始化生成 0600 文件且绝不覆盖既有主密钥", async () => {
    const dir = await tempDir();
    const file = join(dir, "nested", "master-key");
    await initializeMasterKey(file, () => Buffer.alloc(32, 9));

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe(`${Buffer.alloc(32, 9).toString("base64")}\n`);
    await expect(initializeMasterKey(file)).rejects.toThrow("已存在");
    expect(await readFile(file, "utf8")).toBe(`${Buffer.alloc(32, 9).toString("base64")}\n`);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mk-master-key-"));
  dirs.push(dir);
  return dir;
}
