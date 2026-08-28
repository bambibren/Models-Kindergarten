import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";
import type { FileSandbox } from "./sandbox.js";
import { ToolExecutionError } from "./tool-error.js";

/** 描述「CommandResult」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  changedFiles: string[];
  deletedFiles: string[];
}

/** 本地演示优先使用 macOS sandbox-exec；其他平台拒绝运行而不是静默降级。 */
export class ProcessSandbox {
  /** 初始化「ProcessSandbox」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly files: FileSandbox) {}

  /** 执行「run」主流程，传播取消与失败并在结束时清理临时资源。 */
async run(
    command: string,
    cwdInput: string | undefined,
    requestedTimeout: number | undefined,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    if (!command.trim()) throw new Error("command 不能为空");
    if (command.length > PRODUCT_CONFIG.tools.process.commandMaxCharacters) {
      throw new ToolExecutionError(
        "command_too_long",
        "resource_limit",
        `命令超过 ${PRODUCT_CONFIG.tools.process.commandMaxCharacters} 个字符资源上限`,
        false,
      );
    }
    if (process.platform !== "darwin") {
      throw new Error("当前终端沙箱只支持 macOS sandbox-exec");
    }
    await access("/usr/bin/sandbox-exec", constants.X_OK);

    const cwd = cwdInput && cwdInput !== "."
      ? this.files.preview(cwdInput)
      : this.files.root;
    assertInside(this.files.root, cwd);
    if (requestedTimeout !== undefined && requestedTimeout > PRODUCT_CONFIG.tools.process.maxTimeoutMs) {
      throw new ToolExecutionError(
        "command_timeout_limit_exceeded",
        "resource_limit",
        `命令请求超时 ${requestedTimeout}ms，超过 ${PRODUCT_CONFIG.tools.process.maxTimeoutMs}ms 资源上限`,
        false,
      );
    }
    const timeoutMs = Math.max(
      PRODUCT_CONFIG.tools.process.minTimeoutMs,
      requestedTimeout ?? PRODUCT_CONFIG.tools.process.defaultTimeoutMs,
    );
    const profile = sandboxProfile(await realpath(this.files.root));
    const args = ["-p", profile, "/bin/zsh", "-lc", command];
    const before = await this.files.snapshotReferenceableFiles();

    let execution: Omit<CommandResult, "changedFiles" | "deletedFiles">;
    try {
      execution = await new Promise<Omit<CommandResult, "changedFiles" | "deletedFiles">>(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolveResult, reject) => {
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
        const append = /** 更新「append」对应状态，并保持写入顺序、原子性与容量约束。 */
(
          current: Buffer<ArrayBufferLike>,
          chunk: Buffer<ArrayBufferLike>,
        ): Buffer<ArrayBufferLike> => {
          const remaining = PRODUCT_CONFIG.tools.process.maxOutputBytes - current.length;
          if (remaining <= 0) {
            truncated = true;
            return current;
          }
          if (chunk.length > remaining) truncated = true;
          return Buffer.concat([current, chunk.subarray(0, remaining)]);
        };
        child.stdout.on("data", /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(chunk: Buffer) => { stdout = append(stdout, chunk); });
        child.stderr.on("data", /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(chunk: Buffer) => { stderr = append(stderr, chunk); });

        const stop = /** 执行「stop」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(): void => {
          if (child.pid) {
            try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
          }
        };
        const timer = setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => { timedOut = true; stop(); }, timeoutMs);
        const abort = /** 执行「abort」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(): void => stop();
        signal.addEventListener("abort", abort, { once: true });
        child.once("error", finishError);
        child.once("close", /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(exitCode, childSignal) => {
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
        /** 完成当前异步桥接，并保证每条分支只结算一次。 */
function cleanup(): void {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          child.removeListener("error", finishError);
        }
        /** 完成当前异步桥接，并保证每条分支只结算一次。 */
function finishError(error: Error): void {
          cleanup();
          reject(error);
        }
      });
    } catch (error) {
      if (!(error instanceof ToolExecutionError)) throw error;
      const changes = fileChanges(before, await this.files.snapshotReferenceableFiles());
      throw new ToolExecutionError(
        error.code,
        error.category,
        error.message,
        error.retryable,
        { ...(typeof error.rawOutput === "object" && error.rawOutput ? error.rawOutput : {}), ...changes },
        {
          cause: error,
          ...(changes.changedFiles.length > 0
            ? { effects: { fileRelativePaths: changes.changedFiles } }
            : {}),
        },
      );
    }
    return { ...execution, ...fileChanges(before, await this.files.snapshotReferenceableFiles()) };
  }
}

/** 执行「fileChanges」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function fileChanges(before: Map<string, string>, after: Map<string, string>): Pick<CommandResult, "changedFiles" | "deletedFiles"> {
  return {
    changedFiles: [...after]
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
([path, digest]) => before.get(path) !== digest)
      .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
([path]) => path),
    deletedFiles: [...before.keys()].filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(path) => !after.has(path)),
  };
}

/** 执行「sandboxProfile」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

/** 执行「allowedEnv」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function allowedEnv(): NodeJS.ProcessEnv {
  const names = ["PATH", "LANG", "LC_ALL", "TMPDIR"];
  return Object.fromEntries(names.flatMap(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]],
  ));
}

/** 校验并规范化「assertInside」输入，非法数据直接返回明确错误。 */
function assertInside(root: string, target: string): void {
  const rel = relative(root, resolve(target));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) return;
  throw new Error("终端 cwd 超出沙箱范围");
}
