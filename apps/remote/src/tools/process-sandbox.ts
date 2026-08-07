import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { FileSandbox } from "./sandbox.js";
import { ToolExecutionError } from "./tool-error.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** 本地演示优先使用 macOS sandbox-exec；其他平台拒绝运行而不是静默降级。 */
export class ProcessSandbox {
  constructor(private readonly files: FileSandbox) {}

  async run(
    command: string,
    cwdInput: string | undefined,
    requestedTimeout: number | undefined,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    if (!command.trim() || command.length > 2_000) throw new Error("command 长度无效");
    if (process.platform !== "darwin") {
      throw new Error("当前终端沙箱只支持 macOS sandbox-exec");
    }
    await access("/usr/bin/sandbox-exec", constants.X_OK);

    const cwd = cwdInput && cwdInput !== "."
      ? this.files.preview(cwdInput)
      : this.files.root;
    assertInside(this.files.root, cwd);
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(100, requestedTimeout ?? DEFAULT_TIMEOUT_MS),
    );
    const profile = sandboxProfile(await realpath(this.files.root));
    const args = ["-p", profile, "/bin/zsh", "-lc", command];

    return await new Promise<CommandResult>((resolveResult, reject) => {
      const child = spawn("/usr/bin/sandbox-exec", args, {
        cwd,
        detached: true,
        env: allowedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let truncated = false;
      let timedOut = false;
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>,
      ): Buffer<ArrayBufferLike> => {
        const remaining = MAX_OUTPUT_BYTES - current.length;
        if (remaining <= 0) {
          truncated = true;
          return current;
        }
        if (chunk.length > remaining) truncated = true;
        return Buffer.concat([current, chunk.subarray(0, remaining)]);
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });

      const stop = (): void => {
        if (child.pid) {
          try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        }
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      const abort = (): void => stop();
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", finishError);
      child.once("close", (exitCode, childSignal) => {
        cleanup();
        if (signal.aborted) return reject(new DOMException("已取消", "AbortError"));
        if (timedOut) {
          return reject(new ToolExecutionError(
            "command_timeout",
            "timeout",
            `命令超过 ${timeoutMs}ms 超时限制`,
            true,
          ));
        }
        resolveResult({
          command,
          cwd,
          exitCode,
          signal: childSignal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          truncated,
        });
      });
      function cleanup(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        child.removeListener("error", finishError);
      }
      function finishError(error: Error): void {
        cleanup();
        reject(error);
      }
    });
  }
}

function sandboxProfile(root: string): string {
  const escaped = root.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `(version 1)
(deny default)
(import "system.sb")
(allow process*)
(allow sysctl-read)
(allow file-read* (subpath "${escaped}"))
(allow file-write* (subpath "${escaped}"))
(deny network*)`;
}

function allowedEnv(): NodeJS.ProcessEnv {
  const names = ["PATH", "LANG", "LC_ALL", "TMPDIR"];
  return Object.fromEntries(names.flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]],
  ));
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, resolve(target));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) return;
  throw new Error("终端 cwd 超出沙箱范围");
}
