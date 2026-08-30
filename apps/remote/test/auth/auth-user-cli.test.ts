import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAuthUserCli } from "../../src/auth/auth-user-cli.js";

describe("服务器账号管理脚本", () => {
  it("支持新增、禁用、启用和修改密码", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mk-auth-cli-"));
    const env = { DATA_DIR: dataDir };
    await runAuthUserCli(["add", "admin"], io("zhanglei234\nzhanglei234\n"), env);
    await runAuthUserCli(["disable", "admin"], io(), env);
    const listed: string[] = [];
    await runAuthUserCli(["list"], io("", listed), env);
    expect(listed.join("")).toContain("admin\t已禁用");
    await runAuthUserCli(["enable", "admin"], io(), env);
    await runAuthUserCli(["reset-password", "admin"], io("new-password\nnew-password\n"), env);
  });

  it("只有完整中文二次确认后才删除账号与所属记录", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mk-auth-delete-"));
    const env = { DATA_DIR: dataDir };
    await runAuthUserCli(["add", "demo"], io("password-1\npassword-1\n"), env);
    const users = JSON.parse(await readFile(join(dataDir, "auth/users.json"), "utf8"));
    const principalId = users.records[0].principalId;
    await expect(runAuthUserCli(["delete", "demo"], io("确认\n"), env)).rejects.toThrow("确认文字不匹配");
    await runAuthUserCli(["delete", "demo"], io("确认删除账号 demo\n"), env);
    const records = JSON.parse(await readFile(join(dataDir, "auth/users.json"), "utf8")).records;
    expect(records).toEqual([]);
    expect(principalId).toMatch(/^user_/u);
  });
});

function io(input = "", output: string[] = []) {
  return {
    read: async () => input,
    write: (message: string) => { output.push(message); },
  };
}
