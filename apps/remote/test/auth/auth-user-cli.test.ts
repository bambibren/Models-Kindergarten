import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAuthUserCli } from "../../src/auth/auth-user-cli.js";
import { AccountDataDeletionService } from "../../src/auth/account-data-deletion-service.js";
import { McpConfigStore } from "../../src/mcp/mcp-config-store.js";

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

  it("清理旧聚合产物时保留其他账号仍引用的 Blob", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mk-auth-owner-data-"));
    const ownHash = "a".repeat(64);
    const otherHash = "b".repeat(64);
    await writeFile(join(dataDir, "artifacts.json"), JSON.stringify({
      schemaVersion: 1,
      records: [
        { artifactId: "mine", ownerId: "owner-a", primary: { sha256: ownHash } },
        { artifactId: "other", ownerId: "owner-b", primary: { sha256: otherHash } },
      ],
    }));
    await mkdir(join(dataDir, "artifact-blobs"));
    await writeFile(join(dataDir, "artifact-blobs", ownHash), "mine");
    await writeFile(join(dataDir, "artifact-blobs", otherHash), "other");
    await new AccountDataDeletionService(dataDir).deleteOwner("owner-a");
    const document = JSON.parse(await readFile(join(dataDir, "artifacts.json"), "utf8"));
    expect(document.records.map((item: { artifactId: string }) => item.artifactId)).toEqual(["other"]);
    expect(await readdir(join(dataDir, "artifact-blobs"))).toEqual([otherHash]);
  });

  it("删除账号时同步清理该账号的 MCP 运行配置", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mk-auth-mcp-data-"));
    await writeFile(join(dataDir, "mcp-installations.json"), JSON.stringify({
      schemaVersion: 1,
      records: [
        { schemaVersion: 1, mcpInstallationId: "mcp-owner-a", ownerId: "owner-a" },
        { schemaVersion: 1, mcpInstallationId: "mcp-owner-b", ownerId: "owner-b" },
      ],
    }));
    const config = new McpConfigStore(join(dataDir, "mcp/config.json"));
    await config.save({
      version: 1,
      servers: [
        { id: "mcp-owner-a", displayName: "A", enabled: true, source: "manual", trust: "untrusted", transport: { kind: "streamable_http", url: "https://a.example/mcp" } },
        { id: "mcp-owner-b", displayName: "B", enabled: true, source: "manual", trust: "untrusted", transport: { kind: "streamable_http", url: "https://b.example/mcp" } },
      ],
      authProfiles: [],
      agentCapabilities: { mcpTools: [], skills: [], resources: [] },
    });

    await new AccountDataDeletionService(dataDir).deleteOwner("owner-a");

    expect((await config.load()).servers.map(/** 构造「map」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(server) => server.id)).toEqual(["mcp-owner-b"]);
  });
});

function io(input = "", output: string[] = []) {
  return {
    read: async () => input,
    write: (message: string) => { output.push(message); },
  };
}
