import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SecretRef } from "./mcp-types.js";

const execFileAsync = promisify(execFile);

type SecretCommandExecutor = (
  file: string,
  args: string[],
) => Promise<{ stdout: string }>;

/** 描述「SecretStore」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

  /** 初始化「HostSecretStore」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    execute: SecretCommandExecutor = /** 执行「execute」主流程，传播取消与失败并在结束时清理临时资源。 */
async (file, args) => {
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

  /** 读取「read」所需数据，并遵守作用域、分页与容量边界。 */
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

  /** 更新「write」对应状态，并保持写入顺序、原子性与容量约束。 */
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

  /** 释放或删除「delete」对应资源，重复调用仍保持安全。 */
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

  /** 校验并规范化「assertKeychainAvailable」输入，非法数据直接返回明确错误。 */
private assertKeychainAvailable(): void {
    if (this.platform !== "darwin") throw new Error("keychain Secret 当前只支持 macOS");
  }
}

/** 判断「isMissingKeychainItem」对应条件，只返回判定结果且不修改输入状态。 */
function isMissingKeychainItem(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === 44 || error.code === "44";
}
