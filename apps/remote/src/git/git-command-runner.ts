import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const TERMINATION_GRACE_MS = 250;

export interface GitCommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  label: string;
  maxBuffer?: number;
}

export type ProcessTreeTermination =
  | { kind: "taskkill"; command: "taskkill"; args: string[] }
  | { kind: "process_group"; pid: number };

/**
 * Git checkout 在 partial clone 下也可能联网，因此所有阶段都要使用同一套代理、低速中止和硬超时。
 * 参数数组直接交给进程，不经过 shell，Windows 与 macOS 共用一条命令主线。
 */
export function runGitCommand(
  args: string[],
  options: GitCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveCommand, rejectCommand) => {
    const detached = process.platform !== "win32";
    const child = spawn("git", args, {
      detached,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let outputBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      signalProcessTree(child.pid, "SIGTERM");
      forceTimer = setTimeout(() => signalProcessTree(child.pid, "SIGKILL"), TERMINATION_GRACE_MS);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      target.push(chunk);
      outputBytes += chunk.byteLength;
      if (outputBytes > maxBuffer && !overflowed) {
        overflowed = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      rejectCommand(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (timedOut) {
        rejectCommand(new Error(`Git ${options.label}超时（operation timed out after ${options.timeoutMs}ms）\n${stderrText}`));
        return;
      }
      if (overflowed) {
        rejectCommand(new Error(`Git ${options.label}输出超过 ${maxBuffer} 字节限制`));
        return;
      }
      if (code !== 0) {
        rejectCommand(new Error(`Git ${options.label}失败（exit ${code ?? signal ?? "unknown"}）\n${stderrText}`));
        return;
      }
      resolveCommand({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

export function buildGitEnvironment(
  base: NodeJS.ProcessEnv,
  detectedProxy?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_HTTP_LOW_SPEED_LIMIT: "1024",
    GIT_HTTP_LOW_SPEED_TIME: "15",
  };
  if (detectedProxy) {
    env.HTTPS_PROXY = detectedProxy;
    env.HTTP_PROXY = detectedProxy;
  }
  return env;
}

export async function resolveGitEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
    return buildGitEnvironment(process.env);
  }
  // Windows 依赖进程环境或 Git 自身配置；Demo 不读取注册表或 WinHTTP 的特殊代理配置。
  if (process.platform !== "darwin") return buildGitEnvironment(process.env);
  try {
    const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      timeout: 3_000,
    });
    return buildGitEnvironment(process.env, parseMacOSHttpsProxy(stdout));
  } catch {
    return buildGitEnvironment(process.env);
  }
}

export function parseMacOSHttpsProxy(value: string): string | undefined {
  const fields = new Map<string, string>();
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
    if (match) fields.set(match[1]!, match[2]!);
  }
  const enabled = fields.get("HTTPSEnable") === "1";
  const host = fields.get("HTTPSProxy");
  const port = Number(fields.get("HTTPSPort"));
  if (!enabled || !host || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return `http://${host}:${port}`;
}

export function processTreeTermination(platform: NodeJS.Platform, pid: number): ProcessTreeTermination {
  return platform === "win32"
    ? { kind: "taskkill", command: "taskkill", args: ["/PID", String(pid), "/T", "/F"] }
    : { kind: "process_group", pid: -pid };
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  const termination = processTreeTermination(process.platform, pid);
  if (termination.kind === "taskkill") {
    const killer = spawn(termination.command, termination.args, {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => undefined);
    killer.unref();
    return;
  }
  try {
    process.kill(termination.pid, signal);
  } catch {
    // 进程可能已在 close 事件到达前退出。
  }
}
