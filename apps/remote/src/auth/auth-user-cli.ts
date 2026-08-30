import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AccountDataDeletionService } from "./account-data-deletion-service.js";
import { PasswordAuthStore } from "./password-auth-store.js";
import { EncryptedFileSecretStore } from "../secrets/encrypted-file-secret-store.js";
import { FileMasterKeySource } from "../secrets/file-master-key.js";

export interface AuthUserCliIo {
  read(): Promise<string>;
  write(message: string): void;
}

export async function runAuthUserCli(args: string[], io: AuthUserCliIo, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [command, username] = args;
  const dataDir = resolve(env.DATA_DIR ?? ".data");
  const store = new PasswordAuthStore(
    resolve(dataDir, "auth/users.json"),
    resolve(dataDir, "auth/sessions.json"),
  );

  if (command === "list") {
    const users = await store.list();
    if (users.length === 0) { io.write("尚未创建账号\n"); return; }
    for (const user of users) io.write(`${user.username}\t${user.disabled ? "已禁用" : "正常"}\t${user.principalId}\n`);
    return;
  }
  if (!username) throw new Error("请提供用户名");

  if (command === "add" || command === "reset-password") {
    const [password = "", repeated = ""] = lines(await io.read());
    if (password !== repeated) throw new Error("两次输入的密码不一致");
    if (command === "add") {
      await store.add(username, password);
      io.write(`账号 ${username} 已创建\n`);
    } else {
      await store.resetPassword(username, password);
      io.write(`账号 ${username} 的密码已修改，原登录会话已失效\n`);
    }
    return;
  }
  if (command === "disable") {
    await store.disable(username);
    io.write(`账号 ${username} 已禁用，业务数据未删除\n`);
    return;
  }
  if (command === "enable") {
    await store.enable(username);
    io.write(`账号 ${username} 已启用\n`);
    return;
  }
  if (command === "delete") {
    const expected = `确认删除账号 ${username}`;
    const confirmation = lines(await io.read())[0] ?? "";
    if (confirmation !== expected) throw new Error(`确认文字不匹配，已取消删除；必须完整输入：${expected}`);
    const user = (await store.list()).find((item) => item.username.toLowerCase() === username.toLowerCase());
    if (!user) throw new Error(`账号不存在: ${username}`);
    const masterKeyFile = resolve(env.MASTER_KEY_FILE ?? ".local/secrets/mk_master_key");
    const vaultFile = resolve(env.CREDENTIAL_VAULT_FILE ?? `${dataDir}/secure/credentials.enc`);
    const secretStore = new EncryptedFileSecretStore(new FileMasterKeySource(masterKeyFile), vaultFile);
    await secretStore.initialize();
    const deleted = await new AccountDataDeletionService(dataDir, secretStore).deleteOwner(user.principalId);
    await store.remove(username);
    io.write(`账号 ${username} 已删除，同时删除 ${deleted.sessions} 个会话和 ${deleted.records} 条业务记录\n`);
    return;
  }
  throw new Error("命令必须是 add、list、reset-password、disable、enable 或 delete");
}

function lines(value: string): string[] {
  return value.replaceAll("\r\n", "\n").split("\n");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAuthUserCli(process.argv.slice(2), {
    read: readStdin,
    write: (message) => process.stdout.write(message),
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
