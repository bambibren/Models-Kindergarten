import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";
import { FileSandbox } from "../tools/sandbox.js";
import { ToolExecutionError } from "../tools/tool-error.js";
import { inspectPptx } from "./pptx-inspector.js";

export interface PptxBuildInput {
  sourcePath: string;
  outputPath: string;
}

export interface PptxBuildResult {
  sourcePath: string;
  outputPath: string;
  sha256: string;
  byteLength: number;
  slides: number;
  entries: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface PptxProcessInput {
  workspaceRoot: string;
  sourcePath: string;
  outputPath: string;
  timeoutMs: number;
}

export interface PptxProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface PptxProcessRunner {
  run(input: PptxProcessInput, signal: AbortSignal): Promise<PptxProcessResult>;
}

export class PptxBuildService {
  constructor(
    private readonly files: FileSandbox,
    private readonly runner: PptxProcessRunner = new SandboxedPptxProcessRunner(),
  ) {}

  async build(input: PptxBuildInput, signal: AbortSignal): Promise<PptxBuildResult> {
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    const sourcePath = validatedSourcePath(input.sourcePath);
    const outputPath = validatedOutputPath(input.outputPath);
    if (sourcePath === outputPath) outputInvalid("源码和输出路径不能相同");
    try { await this.files.readBytes(sourcePath, PRODUCT_CONFIG.pptx.maxSourceBytes); }
    catch (error) { sourceInvalid(errorText(error)); }
    let sourceAbsolute: string;
    let outputAbsolute: string;
    try {
      sourceAbsolute = this.files.preview(sourcePath);
      outputAbsolute = this.files.preview(outputPath);
    } catch (error) {
      outputInvalid(errorText(error));
    }
    const before = await fileStamp(outputAbsolute);

    const execution = await this.runner.run({
      workspaceRoot: this.files.root,
      sourcePath: sourceAbsolute,
      outputPath: outputAbsolute,
      timeoutMs: PRODUCT_CONFIG.pptx.buildTimeoutMs,
    }, signal);
    if (execution.exitCode !== 0) {
      throw new ToolExecutionError(
        "pptx_build_failed",
        "execution",
        `PPTX_BUILD_FAILED: 源码执行失败${execution.stderr ? `：${short(execution.stderr)}` : ""}`,
        false,
        execution,
      );
    }
    const after = await fileStamp(outputAbsolute);
    if (!after) outputInvalid("源码没有写出指定 .pptx 文件");
    if (before && before.ctimeNs === after.ctimeNs) outputInvalid("指定 .pptx 没有被本次构建更新");

    let content: Buffer;
    try {
      ({ content } = await this.files.readBytes(outputPath, PRODUCT_CONFIG.pptx.maxOutputBytes));
    } catch (error) {
      const message = errorText(error);
      if (message.includes("超过")) {
        throw new ToolExecutionError("pptx_resource_limit", "resource_limit", `PPTX_RESOURCE_LIMIT: ${message}`, false);
      }
      outputInvalid(message);
    }
    if (content.byteLength < 1) outputInvalid("输出文件为空");
    let inspection: ReturnType<typeof inspectPptx>;
    try { inspection = inspectPptx(content); }
    catch (error) {
      throw new ToolExecutionError(
        "pptx_structure_invalid",
        "validation",
        errorText(error),
        false,
      );
    }
    return {
      sourcePath,
      outputPath,
      sha256: createHash("sha256").update(content).digest("hex"),
      byteLength: content.byteLength,
      ...inspection,
      stdout: execution.stdout,
      stderr: execution.stderr,
      truncated: execution.truncated,
    };
  }
}

export class SandboxedPptxProcessRunner implements PptxProcessRunner {
  async run(input: PptxProcessInput, signal: AbortSignal): Promise<PptxProcessResult> {
    const workspaceRoot = await realpath(input.workspaceRoot);
    const sourcePath = resolve(workspaceRoot, relative(input.workspaceRoot, input.sourcePath));
    const dependencyRoots = await pptxDependencyRoots();
    const nodePath = dependencyRoots.find((root) => root.endsWith(`${sep}node_modules`));
    const env = allowedEnv(nodePath);
    if (process.platform === "darwin") {
      await access("/usr/bin/sandbox-exec", constants.X_OK);
      return runProcess("/usr/bin/sandbox-exec", [
        "-p",
        sandboxProfile(workspaceRoot, dependencyRoots),
        process.execPath,
        sourcePath,
      ], workspaceRoot, input.timeoutMs, signal, env);
    }
    if (process.platform === "linux") {
      const unshare = process.env.PPTX_LINUX_UNSHARE_PATH ?? "/usr/bin/unshare";
      try { await access(unshare, constants.X_OK); }
      catch {
        throw new ToolExecutionError(
          "pptx_dependency_unavailable",
          "dependency_unavailable",
          "PPTX_DEPENDENCY_UNAVAILABLE: Linux 构建环境缺少 unshare",
          false,
        );
      }
      const permissionArgs = [
        "--permission",
        `--allow-fs-read=${workspaceRoot}`,
        `--allow-fs-write=${workspaceRoot}`,
        ...dependencyRoots.map((root) => `--allow-fs-read=${root}`),
        sourcePath,
      ];
      return runProcess(unshare, ["--user", "--map-root-user", "--net", "--", process.execPath, ...permissionArgs], workspaceRoot, input.timeoutMs, signal, env);
    }
    throw new ToolExecutionError(
      "pptx_dependency_unavailable",
      "dependency_unavailable",
      `PPTX_DEPENDENCY_UNAVAILABLE: 当前平台不支持受控 PPTX Worker: ${process.platform}`,
      false,
    );
  }
}

async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<PptxProcessResult> {
  return new Promise<PptxProcessResult>((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const remaining = PRODUCT_CONFIG.pptx.maxProcessOutputBytes - current.byteLength;
      if (remaining <= 0) {
        truncated = true;
        return current;
      }
      if (chunk.byteLength > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const stop = (): void => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const abort = (): void => stop();
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", finishError);
    child.once("close", (exitCode, childSignal) => {
      cleanup();
      if (signal.aborted) return reject(new DOMException("已取消", "AbortError"));
      if (timedOut) {
        return reject(new ToolExecutionError(
          "pptx_build_timeout",
          "timeout",
          `PPTX_BUILD_TIMEOUT: 构建超过 ${timeoutMs}ms`,
          false,
        ));
      }
      resolveResult({
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

async function pptxDependencyRoots(): Promise<string[]> {
  let resolved: string;
  try { resolved = fileURLToPath(import.meta.resolve("pptxgenjs")); }
  catch {
    throw new ToolExecutionError(
      "pptx_dependency_unavailable",
      "dependency_unavailable",
      "PPTX_DEPENDENCY_UNAVAILABLE: 未安装 pptxgenjs",
      false,
    );
  }
  const marker = `${sep}node_modules${sep}.pnpm${sep}`;
  const markerAt = resolved.indexOf(marker);
  const roots = [dirname(resolved)];
  if (markerAt >= 0) roots.push(resolved.slice(0, markerAt + marker.length - 1));
  const packageModules = findAncestorNodeModules(resolved);
  if (packageModules) roots.push(packageModules);
  return [...new Set(await Promise.all(roots.map((root) => realpath(root))))];
}

function findAncestorNodeModules(path: string): string | undefined {
  let current = dirname(path);
  while (true) {
    if (current.endsWith(`${sep}node_modules`)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function sandboxProfile(workspace: string, readRoots: string[]): string {
  const quoted = [workspace, ...readRoots].map(escapeProfile);
  const metadata = [...new Set([workspace, ...readRoots].flatMap(ancestorPaths))].map(escapeProfile);
  return `(version 1)
(deny default)
(import "system.sb")
(allow process*)
(allow sysctl-read)
(allow file-read-metadata${metadata.map((path) => ` (literal "${path}")`).join("")})
(allow file-read*${quoted.map((path) => ` (subpath "${path}")`).join("")})
(allow file-write* (subpath "${escapeProfile(workspace)}"))
(deny network*)`;
}

function ancestorPaths(path: string): string[] {
  const values: string[] = [];
  let current = dirname(path);
  while (current !== dirname(current)) {
    values.push(current);
    current = dirname(current);
  }
  return values;
}

function escapeProfile(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function allowedEnv(nodePath: string | undefined): NodeJS.ProcessEnv {
  const names = ["PATH", "LANG", "LC_ALL", "TMPDIR"];
  return {
    ...Object.fromEntries(names.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    )),
    ...(nodePath ? { NODE_PATH: nodePath } : {}),
  };
}

function validatedSourcePath(path: string): string {
  if (![".js", ".cjs", ".mjs"].includes(extname(path).toLowerCase())) sourceInvalid("源码必须是 .js、.cjs 或 .mjs");
  return path;
}

function validatedOutputPath(path: string): string {
  if (extname(path).toLowerCase() !== ".pptx") outputInvalid("输出必须是 .pptx");
  return path;
}

function sourceInvalid(detail: string): never {
  throw new ToolExecutionError("pptx_source_invalid", "validation", `PPTX_SOURCE_INVALID: ${detail}`, false);
}

function outputInvalid(detail: string): never {
  throw new ToolExecutionError("pptx_output_invalid", "validation", `PPTX_OUTPUT_INVALID: ${detail}`, false);
}

async function fileStamp(path: string): Promise<{ ctimeNs: bigint } | undefined> {
  try {
    const info = await stat(path, { bigint: true });
    if (!info.isFile()) outputInvalid("输出路径不是普通文件");
    return { ctimeNs: info.ctimeNs };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function short(value: string): string {
  const text = value.trim();
  return text.length <= 800 ? text : `${text.slice(0, 800)}…`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
