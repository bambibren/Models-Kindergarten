import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SecretRef } from "./mcp-types.js";

const execFileAsync = promisify(execFile);

export interface SecretStore {
  read(ref: SecretRef): Promise<string>;
}

/** Secret 只在发请求或启动子进程前解析，绝不写回 MCP 配置或运行 Trace。 */
export class HostSecretStore implements SecretStore {
  async read(ref: SecretRef): Promise<string> {
    if (ref.provider === "env") {
      const value = process.env[ref.key];
      if (!value) throw new Error(`环境 Secret 不存在: ${ref.key}`);
      return value;
    }
    if (process.platform !== "darwin") {
      throw new Error("keychain Secret 当前只支持 macOS");
    }
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/security",
        ["find-generic-password", "-w", "-s", ref.key],
        { encoding: "utf8", maxBuffer: 64 * 1024 },
      );
      const value = stdout.trimEnd();
      if (!value) throw new Error("空 Secret");
      return value;
    } catch (error) {
      throw new Error(`Keychain Secret 不存在: ${ref.key}`, { cause: error });
    }
  }
}
