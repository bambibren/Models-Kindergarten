import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SecretRef } from "./mcp-types.js";

const execFileAsync = promisify(execFile);

type SecretCommandExecutor = (
  file: string,
  args: string[],
) => Promise<{ stdout: string }>;

export interface SecretStore {
  read(ref: SecretRef): Promise<string>;
}

/** 只有控制面可持有写能力；Runtime 仍只依赖只读 SecretStore。 */
export interface WritableSecretStore extends SecretStore {
  write(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
}

/** Secret 只在发请求或启动子进程前解析，绝不写回 MCP 配置或运行 Trace。 */
export class HostSecretStore implements WritableSecretStore {
  private readonly execute: SecretCommandExecutor;

  constructor(
    execute: SecretCommandExecutor = async (file, args) => {
      const { stdout } = await execFileAsync(file, args, {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
      });
      return { stdout };
    },
    private readonly platform = process.platform,
  ) {
    this.execute = execute;
  }

  async read(ref: SecretRef): Promise<string> {
    if (ref.provider === "env") {
      const value = process.env[ref.key];
      if (!value) throw new Error(`环境 Secret 不存在: ${ref.key}`);
      return value;
    }
    if (this.platform !== "darwin") {
      throw new Error("keychain Secret 当前只支持 macOS");
    }
    try {
      const { stdout } = await this.execute(
        "/usr/bin/security",
        ["find-generic-password", "-w", "-a", "local-admin", "-s", ref.key],
      );
      const value = stdout.trimEnd();
      if (!value) throw new Error("空 Secret");
      return value;
    } catch {
      throw new Error(`Keychain Secret 不存在: ${ref.key}`);
    }
  }

  async write(ref: SecretRef, value: string): Promise<void> {
    if (ref.provider !== "keychain") throw new Error("环境 Secret 不能由应用写入");
    if (!value) throw new Error("Secret 不能为空");
    this.assertKeychainAvailable();
    try {
      await this.execute(
        "/usr/bin/security",
        ["add-generic-password", "-U", "-a", "local-admin", "-s", ref.key, "-w", value],
      );
    } catch {
      // 不保留底层异常：security 的异常对象可能包含带明文 Secret 的 argv/cmd。
      throw new Error("无法写入 macOS Keychain");
    }
  }

  async delete(ref: SecretRef): Promise<void> {
    if (ref.provider !== "keychain") throw new Error("环境 Secret 不能由应用删除");
    this.assertKeychainAvailable();
    try {
      await this.execute(
        "/usr/bin/security",
        ["delete-generic-password", "-a", "local-admin", "-s", ref.key],
      );
    } catch (error) {
      // security 以 44 表示目标不存在；只有这一种情况可安全视作幂等成功。
      if (isMissingKeychainItem(error)) return;
      throw new Error("无法从 macOS Keychain 删除 Secret");
    }
  }

  private assertKeychainAvailable(): void {
    if (this.platform !== "darwin") throw new Error("keychain Secret 当前只支持 macOS");
  }
}

function isMissingKeychainItem(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === 44 || error.code === "44";
}
