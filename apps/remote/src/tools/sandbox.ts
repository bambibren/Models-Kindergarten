import {
  readdir,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";

const MAX_FILE_BYTES = PRODUCT_CONFIG.tools.file.maxBytes;
const MAX_PATH_LENGTH = 240;

export interface SandboxWriteResult {
  path: string;
  oldText: string | null;
  newText: string;
}

export interface SandboxListItem {
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface SandboxFileItem {
  path: string;
  size: number;
}

/**
 * Agent 只看到相对路径。每次访问都会重新校验真实路径，拒绝绝对路径、
 * 父目录穿越和符号链接，避免模型输入逃逸到宿主机其他位置。
 */
export class FileSandbox {
  private rootReal?: string;

  constructor(readonly root: string) {
    if (!isAbsolute(root)) throw new Error("沙箱根目录必须是绝对路径");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    this.rootReal = await realpath(this.root);
  }

  preview(input: string): string {
    const parts = cleanParts(input);
    const target = resolve(this.root, ...parts);
    this.assertInside(target);
    return target;
  }

  async readText(input: string): Promise<{ path: string; content: string }> {
    await this.ensureReady();
    const target = this.preview(input);
    await this.assertSafeComponents(target, false);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("目标不是普通文件");
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`文件超过 ${MAX_FILE_BYTES} 字节限制`);
    }
    return { path: target, content: await readFile(target, "utf8") };
  }

  async readBytes(input: string, maxBytes = MAX_FILE_BYTES): Promise<{ path: string; content: Buffer }> {
    await this.ensureReady();
    const target = this.preview(input);
    await this.assertSafeComponents(target, false);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("目标不是普通文件");
    if (info.size > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节限制`);
    return { path: target, content: await readFile(target) };
  }

  /** 发布 Bundle 时只返回安全的普通文件；发现符号链接或特殊文件直接失败。 */
  async walkFiles(input = "."): Promise<SandboxFileItem[]> {
    await this.ensureReady();
    const start = input === "." ? this.root : this.preview(input);
    await this.assertSafeComponents(start, false);
    const startInfo = await stat(start);
    if (!startInfo.isDirectory()) throw new Error("目标不是目录");
    const files: SandboxFileItem[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true }))
        .toSorted((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const target = resolve(directory, entry.name);
        const itemPath = relative(this.root, target).split(sep).join("/");
        if (entry.isSymbolicLink()) throw new Error(`Bundle 不允许符号链接: ${itemPath}`);
        await this.assertSafeComponents(target, false);
        if (entry.isDirectory()) {
          await visit(target);
          continue;
        }
        if (!entry.isFile()) throw new Error(`Bundle 只允许普通文件: ${itemPath}`);
        const info = await stat(target);
        if (!info.isFile()) throw new Error(`Bundle 只允许普通文件: ${itemPath}`);
        files.push({ path: itemPath, size: info.size });
      }
    };
    await visit(start);
    return files;
  }

  async list(input = ".", maxItems = 200): Promise<SandboxListItem[]> {
    await this.ensureReady();
    const target = input === "." ? this.root : this.preview(input);
    await this.assertSafeComponents(target, false);
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error("目标不是目录");
    const values = await readdir(target, { withFileTypes: true });
    return values
      .filter((item) => !item.isSymbolicLink() && (item.isFile() || item.isDirectory()))
      .slice(0, maxItems)
      .map((item) => ({
        path: relative(this.root, resolve(target, item.name)) || ".",
        type: item.isDirectory() ? "directory" as const : "file" as const,
      }));
  }

  async writeText(input: string, content: string): Promise<SandboxWriteResult> {
    await this.ensureReady();
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new Error(`写入内容超过 ${MAX_FILE_BYTES} 字节限制`);
    }

    const target = this.preview(input);
    const parent = resolve(target, "..");
    await this.ensureSafeDirectory(parent);
    await this.assertSafeTarget(target);

    let oldText: string | null = null;
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error("目标不是普通文件");
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(`原文件超过 ${MAX_FILE_BYTES} 字节限制`);
      }
      oldText = await readFile(target, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    await writeFile(target, content, { encoding: "utf8", flag: "w" });
    return { path: target, oldText, newText: content };
  }

  async writeBytes(input: string, content: Uint8Array, maxBytes = PRODUCT_CONFIG.artifact.maxFileBytes): Promise<{ path: string; bytes: number }> {
    await this.ensureReady();
    if (content.byteLength > maxBytes) throw new Error(`写入内容超过 ${maxBytes} 字节限制`);
    const target = this.preview(input);
    await this.ensureSafeDirectory(resolve(target, ".."));
    await this.assertSafeTarget(target);
    await writeFile(target, content, { flag: "w" });
    return { path: target, bytes: content.byteLength };
  }

  /**
   * 终端命令不会像 write_file 一样声明目标路径，因此只能在同一 FileSandbox
   * 边界内对可预览普通文件做内容快照。符号链接、超限文件和特殊文件不进入引用链。
   */
  async snapshotReferenceableFiles(): Promise<Map<string, string>> {
    await this.ensureReady();
    const snapshot = new Map<string, string>();
    const visit = async (directory: string, prefix: string): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true }))
        .toSorted((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        let target: string;
        try {
          target = this.preview(path);
        } catch {
          // 终端可以创建 FileSandbox 不接受的文件名；这类文件不能进入预览引用链。
          continue;
        }
        await this.assertSafeComponents(target, false);
        if (entry.isDirectory()) {
          await visit(target, path);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await stat(target);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
        snapshot.set(path, createHash("sha256").update(await readFile(target)).digest("hex"));
      }
    };
    await visit(this.root, "");
    return snapshot;
  }

  private async ensureReady(): Promise<void> {
    if (!this.rootReal) await this.initialize();
  }

  private assertInside(target: string): void {
    const rel = relative(this.root, target);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
      return;
    }
    throw new Error("路径超出沙箱范围");
  }

  private async assertSafeComponents(target: string, allowMissing: boolean): Promise<void> {
    const rel = relative(this.root, target);
    let current = this.root;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = resolve(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error("沙箱路径不允许符号链接");
      } catch (error) {
        if (allowMissing && isMissing(error)) return;
        throw error;
      }
      const actual = await realpath(current);
      this.assertRealInside(actual);
    }
  }

  private async ensureSafeDirectory(target: string): Promise<void> {
    this.assertInside(target);
    const rel = relative(this.root, target);
    let current = this.root;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = resolve(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error("沙箱目录路径无效");
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        try {
          await mkdir(current);
        } catch (mkdirError) {
          // 同一轮允许多个 write_file 并行写入同一新目录；另一调用已创建目录不是失败。
          if (!isAlreadyExists(mkdirError)) throw mkdirError;
          const raced = await lstat(current);
          if (raced.isSymbolicLink() || !raced.isDirectory()) throw new Error("沙箱目录路径无效");
        }
      }
      this.assertRealInside(await realpath(current));
    }
  }

  private async assertSafeTarget(target: string): Promise<void> {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("沙箱文件不允许符号链接");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private assertRealInside(target: string): void {
    const root = this.rootReal;
    if (!root) throw new Error("沙箱尚未初始化");
    const rel = relative(root, target);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
      return;
    }
    throw new Error("真实路径超出沙箱范围");
  }
}

function cleanParts(input: string): string[] {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("path 必须是非空字符串");
  }
  if (input.length > MAX_PATH_LENGTH) throw new Error("path 过长");
  if (isAbsolute(input) || input.includes("\\")) {
    throw new Error("path 必须使用沙箱内的相对 POSIX 路径");
  }
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("path 不允许空段、. 或 ..");
  }
  return parts;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
