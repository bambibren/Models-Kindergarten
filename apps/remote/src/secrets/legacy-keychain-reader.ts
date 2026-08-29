import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LegacySecretSource {
  read(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
}

type SecretCommandExecutor = (file: string, args: string[]) => Promise<{ stdout: string }>;

/** 只用于把升级前已经存在的 Keychain 项搬进统一 Vault；新凭据永远不写 Keychain。 */
export class LegacyMacKeychainReader implements LegacySecretSource {
  constructor(
    private readonly execute: SecretCommandExecutor = async (file, args) => {
      const { stdout } = await execFileAsync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 });
      return { stdout };
    },
    private readonly platform = process.platform,
  ) {}

  async read(key: string): Promise<string | undefined> {
    if (this.platform !== "darwin") return undefined;
    try {
      const { stdout } = await this.execute(
        "/usr/bin/security",
        ["find-generic-password", "-w", "-a", "local-admin", "-s", key],
      );
      const value = stdout.trimEnd();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  async delete(key: string): Promise<void> {
    if (this.platform !== "darwin") return;
    try {
      await this.execute(
        "/usr/bin/security",
        ["delete-generic-password", "-a", "local-admin", "-s", key],
      );
    } catch (error) {
      if (isMissingKeychainItem(error)) return;
      throw new Error("旧 Keychain Secret 清理失败");
    }
  }
}

function isMissingKeychainItem(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === 44 || error.code === "44";
}
