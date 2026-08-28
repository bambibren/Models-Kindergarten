import {
  chmod,
  readdir,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";

const MAX_FILE_BYTES = PRODUCT_CONFIG.tools.file.maxBytes;
const MAX_PATH_LENGTH = 240;

/** 描述「SandboxWriteResult」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SandboxWriteResult {
  path: string;
  oldText: string | null;
  newText: string;
}

/** 描述一次按行替换；旧文本按字面值匹配，不解释正则表达式。 */
export interface SandboxTextEdit {
  oldText: string;
  newText: string;
}

/** 描述按行替换结果，供 Tool diff、文件引用和模型回执复用。 */
export interface SandboxEditResult extends SandboxWriteResult {
  replacements: number[];
  bytes: number;
}

/** 描述「SandboxListItem」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SandboxListItem {
  path: string;
  type: "file" | "directory";
  size?: number;
}

/** 描述「SandboxFileItem」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

  /** 初始化「FileSandbox」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(readonly root: string) {
    if (!isAbsolute(root)) throw new Error("沙箱根目录必须是绝对路径");
  }

  /** 执行「initialize」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    this.rootReal = await realpath(this.root);
  }

  /** 执行「preview」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
preview(input: string): string {
    const parts = cleanParts(input);
    const target = resolve(this.root, ...parts);
    this.assertInside(target);
    return target;
  }

  /** 读取「readText」所需数据，并遵守作用域、分页与容量边界。 */
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

  /** 读取「readBytes」所需数据，并遵守作用域、分页与容量边界。 */
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
  async walkFiles(input = ".", maxItems = Number.MAX_SAFE_INTEGER): Promise<SandboxFileItem[]> {
    await this.ensureReady();
    const start = input === "." ? this.root : this.preview(input);
    await this.assertSafeComponents(start, false);
    const startInfo = await stat(start);
    if (!startInfo.isDirectory()) throw new Error("目标不是目录");
    const files: SandboxFileItem[] = [];
    const visit = /** 执行「visit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async (directory: string): Promise<void> => {
      if (files.length > maxItems) return;
      const entries = (await readdir(directory, { withFileTypes: true }))
        .toSorted(/** 执行「entries」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files.length > maxItems) break;
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

  /** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
async list(input = ".", maxItems = 200): Promise<SandboxListItem[]> {
    await this.ensureReady();
    const target = input === "." ? this.root : this.preview(input);
    await this.assertSafeComponents(target, false);
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error("目标不是目录");
    const values = await readdir(target, { withFileTypes: true });
    return values
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !item.isSymbolicLink() && (item.isFile() || item.isDirectory()))
      .slice(0, maxItems)
      .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({
        path: relative(this.root, resolve(target, item.name)) || ".",
        type: item.isDirectory() ? "directory" as const : "file" as const,
      }));
  }

  /** 更新「writeText」对应状态，并保持写入顺序、原子性与容量约束。 */
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

  /**
   * 按提交顺序精确替换多个旧文本片段；全部片段验证成功后才原子写回，
   * 避免后续片段失败时留下只完成一半的文件。
   */
  async editText(input: string, edits: SandboxTextEdit[]): Promise<SandboxEditResult> {
    await this.ensureReady();
    if (!Array.isArray(edits) || edits.length === 0) throw new Error("edits 必须是非空数组");

    const target = this.preview(input);
    await this.assertSafeComponents(target, false);
    await this.assertSafeTarget(target);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("目标不是普通文件");
    if (info.size > MAX_FILE_BYTES) throw new Error(`原文件超过 ${MAX_FILE_BYTES} 字节限制`);

    const oldText = await readFile(target, "utf8");
    let newText = oldText;
    const replacements: number[] = [];
    for (const [index, edit] of edits.entries()) {
      if (typeof edit.oldText !== "string" || edit.oldText.length === 0) {
        throw new Error(`第 ${index + 1} 项 old_text 必须是非空字符串`);
      }
      if (typeof edit.newText !== "string") {
        throw new Error(`第 ${index + 1} 项 new_text 必须是字符串`);
      }
      const matches = literalOccurrences(newText, edit.oldText);
      if (matches !== 1) {
        throw new Error(`第 ${index + 1} 项旧文本必须恰好匹配一次，实际匹配 ${matches} 次`);
      }
      newText = newText.replace(edit.oldText, () => edit.newText);
      replacements.push(matches);
    }

    const bytes = Buffer.byteLength(newText, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new Error(`写入内容超过 ${MAX_FILE_BYTES} 字节限制`);

    // 临时文件与目标文件位于同一目录，rename 才能提供同文件系统内的原子替换。
    const temporary = `${target}.edit-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, newText, { encoding: "utf8", flag: "wx" });
      await chmod(temporary, info.mode);
      // 写回前复核原内容，避免等待期间的外部修改被旧快照静默覆盖。
      if (await readFile(target, "utf8") !== oldText) {
        throw new Error("目标文件已被并发修改，请重新读取后再按行替换");
      }
      await rename(temporary, target);
    } finally {
      // rename 成功后临时路径已不存在；force 清理同时覆盖写入或替换失败路径。
      await rm(temporary, { force: true });
    }
    return { path: target, oldText, newText, replacements, bytes };
  }

  /** 更新「writeBytes」对应状态，并保持写入顺序、原子性与容量约束。 */
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
    const visit = /** 执行「visit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async (directory: string, prefix: string): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true }))
        .toSorted(/** 执行「entries」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(left, right) => left.name.localeCompare(right.name));
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

  /** 校验并取得「ensureReady」所需对象；缺失或归属不符时立即抛出明确错误。 */
private async ensureReady(): Promise<void> {
    if (!this.rootReal) await this.initialize();
  }

  /** 校验并规范化「assertInside」输入，非法数据直接返回明确错误。 */
private assertInside(target: string): void {
    const rel = relative(this.root, target);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
      return;
    }
    throw new Error("路径超出沙箱范围");
  }

  /** 校验并规范化「assertSafeComponents」输入，非法数据直接返回明确错误。 */
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

  /** 校验并取得「ensureSafeDirectory」所需对象；缺失或归属不符时立即抛出明确错误。 */
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

  /** 校验并规范化「assertSafeTarget」输入，非法数据直接返回明确错误。 */
private async assertSafeTarget(target: string): Promise<void> {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("沙箱文件不允许符号链接");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  /** 校验并规范化「assertRealInside」输入，非法数据直接返回明确错误。 */
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

/** 执行「cleanParts」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function cleanParts(input: string): string[] {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("path 必须是非空字符串");
  }
  if (input.length > MAX_PATH_LENGTH) throw new Error("path 过长");
  if (isAbsolute(input) || input.includes("\\")) {
    throw new Error("path 必须使用沙箱内的相对 POSIX 路径");
  }
  const parts = input.split("/");
  if (parts.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(part) => !part || part === "." || part === "..")) {
    throw new Error("path 不允许空段、. 或 ..");
  }
  return parts;
}

/** 判断「isMissing」对应条件，只返回判定结果且不修改输入状态。 */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** 判断「isAlreadyExists」对应条件，只返回判定结果且不修改输入状态。 */
function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

/** 统计非空字面值片段，保证按行替换不会误用正则或批量替换语义。 */
function literalOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - search.length) {
    const index = content.indexOf(search, offset);
    if (index < 0) break;
    count += 1;
    offset = index + search.length;
  }
  return count;
}
