import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "./mcp-types.js";
import type { SecretStore } from "./secret-store.js";

/**
 * stdio Server 是宿主机子进程，不是普通 Tool。这里在进程创建前固定命令、环境和
 * macOS sandbox-exec 策略，避免模型输入直接变成新进程权限。
 */
export async function stdioParameters(
  server: McpServerConfig,
  secrets: SecretStore,
  defaultSandboxRoot: string,
): Promise<StdioServerParameters> {
  if (server.transport.kind !== "stdio") throw new Error("不是 stdio MCP 配置");
  if (process.platform !== "darwin") {
    throw new Error("安全 stdio MCP 当前只支持 macOS sandbox-exec");
  }
  await access("/usr/bin/sandbox-exec", constants.X_OK);
  const transport = server.transport;
  const cwd = resolve(transport.cwd ?? defaultSandboxRoot);
  const readPaths = await normalizedPaths([
    defaultSandboxRoot,
    cwd,
    ...(transport.sandbox?.readPaths ?? []),
  ]);
  const writePaths = await normalizedPaths([
    defaultSandboxRoot,
    ...(transport.sandbox?.writePaths ?? []),
  ], true);
  const env = getDefaultEnvironment();
  for (const [name, ref] of Object.entries(transport.envRefs ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new Error(`MCP 环境变量名无效: ${name}`);
    env[name] = await secrets.read(ref);
  }
  const profile = sandboxProfile(readPaths, writePaths, transport.sandbox?.network === true);
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-p", profile, transport.command, ...(transport.args ?? [])],
    cwd,
    env,
    stderr: "pipe",
    maxBufferSize: 4 * 1024 * 1024,
  };
}

/** 校验并规范化「normalizedPaths」输入，非法数据直接返回明确错误。 */
async function normalizedPaths(values: string[], allowMissing = false): Promise<string[]> {
  const results = new Set<string>();
  for (const value of values) {
    const absolute = isAbsolute(value) ? resolve(value) : resolve(value);
    try {
      results.add(await realpath(absolute));
    } catch (error) {
      if (!allowMissing) throw new Error(`MCP 沙箱路径不存在: ${absolute}`, { cause: error });
      results.add(absolute);
    }
  }
  return [...results];
}

/** 执行「sandboxProfile」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function sandboxProfile(readPaths: string[], writePaths: string[], network: boolean): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process*)",
    "(allow sysctl-read)",
    ...readPaths.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(path) => `(allow file-read* (subpath "${escapeProfile(path)}"))`),
    ...writePaths.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(path) => `(allow file-write* (subpath "${escapeProfile(path)}"))`),
    network ? "(allow network*)" : "(deny network*)",
  ];
  return lines.join("\n");
}

/** 执行「escapeProfile」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function escapeProfile(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
