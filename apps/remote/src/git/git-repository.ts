import { rm } from "node:fs/promises";
import { resolveGitEnvironment, runGitCommand } from "./git-command-runner.js";

const CLONE_ATTEMPTS = 2;
const NETWORK_TIMEOUT_MS = 60_000;
const LOCAL_TIMEOUT_MS = 15_000;

/** 已克隆仓库的最小操作集合；领域代码不直接拼 Git 子命令。 */
export class GitRepository {
  /** 初始化「GitRepository」所需依赖，不在构造阶段启动不可回收的后台任务。 */
private constructor(
    readonly root: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  /** 复制「clone」返回值，防止调用方通过共享引用修改仓储内部状态。 */
static async clone(url: string, target: string): Promise<GitRepository> {
    const env = await resolveGitEnvironment();
    await cloneWithRetry(url, target, env);
    return new GitRepository(target, env);
  }

  /** 执行「resolveCommit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async resolveCommit(ref: string): Promise<string> {
    const { stdout } = await runGitCommand(
      ["-C", this.root, "rev-parse", `${ref}^{commit}`],
      { env: this.env, timeoutMs: LOCAL_TIMEOUT_MS, label: "解析仓库 commit" },
    );
    return validCommit(stdout);
  }

  /** 读取「listTreePaths」所需数据，并遵守作用域、分页与容量边界。 */
async listTreePaths(commit: string, scope = "."): Promise<string[]> {
    const args = ["-C", this.root, "ls-tree", "-r", "-z", "--name-only", validCommit(commit)];
    if (scope !== ".") args.push("--", scope);
    const { stdout } = await runGitCommand(args, {
      env: this.env,
      timeoutMs: LOCAL_TIMEOUT_MS,
      label: "读取仓库目录树",
    });
    return stdout.split("\0").filter(Boolean);
  }

  /** 执行「checkout」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async checkout(ref: string, subdirectory = "."): Promise<void> {
    if (subdirectory !== ".") {
      await runGitCommand(
        ["-C", this.root, "sparse-checkout", "init", "--cone"],
        { env: this.env, timeoutMs: LOCAL_TIMEOUT_MS, label: "初始化稀疏检出" },
      );
      await runGitCommand(
        ["-C", this.root, "sparse-checkout", "set", "--", subdirectory],
        { env: this.env, timeoutMs: LOCAL_TIMEOUT_MS, label: "设置稀疏目录" },
      );
    }
    await runGitCommand(
      ["-C", this.root, "checkout", "--detach", ref],
      { env: this.env, timeoutMs: NETWORK_TIMEOUT_MS, label: "检出仓库内容" },
    );
  }

  /** 执行「currentCommit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async currentCommit(): Promise<string> {
    const { stdout } = await runGitCommand(
      ["-C", this.root, "rev-parse", "HEAD"],
      { env: this.env, timeoutMs: LOCAL_TIMEOUT_MS, label: "确认仓库 commit" },
    );
    return validCommit(stdout);
  }
}

/** 网络瞬断只重试一次；格式、权限、仓库不存在等确定性错误立即返回。 */
async function cloneWithRetry(url: string, target: string, env: NodeJS.ProcessEnv): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CLONE_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await rm(target, { recursive: true, force: true });
      await new Promise(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolveDelay) => setTimeout(resolveDelay, 500));
    }
    try {
      await runGitCommand(
        ["clone", "--filter=blob:none", "--no-checkout", url, target],
        { env, timeoutMs: NETWORK_TIMEOUT_MS, label: "克隆仓库" },
      );
      return;
    } catch (error) {
      lastError = error;
      if (!retryableConnectionError(error) || attempt === CLONE_ATTEMPTS) throw error;
    }
  }
  throw lastError;
}

/** 执行「validCommit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function validCommit(value: string): string {
  const commit = value.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("无法固定 Git commit");
  return commit;
}

/** 执行「retryableConnectionError」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function retryableConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /could not resolve host|failed to connect|connection timed out|operation timed out|curl \d+|early eof|expected flush after ref listing|connection reset/i.test(message);
}
