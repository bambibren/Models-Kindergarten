import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";

interface SkillBundleFile {
  path: string;
  encoding: "base64";
  byteLength: number;
  sha256: string;
  content: string;
}

interface SkillBundle {
  schemaVersion: 1;
  kind: "mk-skill-bundle";
  name: string;
  contentHash: string;
  files: SkillBundleFile[];
}

const requestTimeoutMs = 12_000;
const maxBundleBytes = Math.ceil(PRODUCT_CONFIG.skill.maxTotalBytes * 4 / 3) + 512 * 1024;

/** 静态资源包只提供文件事实；仍由 SkillInstaller 的隔离目录与统一 Validator 决定能否发布。 */
export async function stageSkillResourceBundle(
  url: string,
  quarantine: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ path: string; contentHash: string }> {
  const bytes = await downloadBundle(url, fetchImpl);
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("SKILL_RESOURCE_INVALID: 响应不是有效 JSON"); }
  const bundle = parseBundle(raw);
  const expectedName = new URL(url).pathname.split("/").filter(Boolean).at(-1);
  if (bundle.name !== expectedName) throw new Error("SKILL_RESOURCE_INVALID: bundle name 与资源 URL 不一致");
  const target = resolve(quarantine, bundle.name);
  const hash = createHash("sha256");
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const file of bundle.files.toSorted(/** 执行「stageSkillResourceBundle」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(left, right) => left.path.localeCompare(right.path))) {
    const path = safeRelativePath(file.path);
    if (seen.has(path)) throw new Error(`SKILL_RESOURCE_INVALID: 重复文件 ${path}`);
    seen.add(path);
    const content = decodeBase64(file.content, path);
    totalBytes += content.byteLength;
    if (totalBytes > PRODUCT_CONFIG.skill.maxTotalBytes) throw new Error("SKILL_RESOURCE_INVALID: Skill 总大小超限");
    if (content.byteLength !== file.byteLength) throw new Error(`SKILL_RESOURCE_INVALID: ${path} byteLength 不匹配`);
    const fileHash = createHash("sha256").update(content).digest("hex");
    if (fileHash !== file.sha256) throw new Error(`SKILL_RESOURCE_INVALID: ${path} SHA-256 不匹配`);
    hash.update(path).update("\0").update(content).update("\0");
    const output = resolve(target, path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, content, { mode: 0o600 });
  }
  const contentHash = hash.digest("hex");
  if (contentHash !== bundle.contentHash) throw new Error("SKILL_RESOURCE_INVALID: bundle contentHash 不匹配");
  return { path: target, contentHash };
}

/** 执行「downloadBundle」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function downloadBundle(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`SKILL_RESOURCE_DOWNLOAD_FAILED: HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/vnd.mk.skill+json") && !contentType.includes("application/json")) {
      throw new Error("SKILL_RESOURCE_INVALID: 响应 Content-Type 不是 Skill JSON bundle");
    }
    return await readBounded(response, maxBundleBytes);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SKILL_RESOURCE_")) throw error;
    throw new Error(`SKILL_RESOURCE_DOWNLOAD_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** 校验并规范化「parseBundle」输入，非法数据直接返回明确错误。 */
function parseBundle(value: unknown): SkillBundle {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "mk-skill-bundle" ||
    typeof value.name !== "string" || !/^[a-z0-9-]+$/.test(value.name) ||
    typeof value.contentHash !== "string" || !sha256(value.contentHash) ||
    !Array.isArray(value.files) || value.files.length < 1 || value.files.length > PRODUCT_CONFIG.skill.maxFiles) {
    throw new Error("SKILL_RESOURCE_INVALID: bundle 结构无效");
  }
  const files = value.files.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item): SkillBundleFile => {
    if (!record(item) || typeof item.path !== "string" || item.encoding !== "base64" ||
      !Number.isInteger(item.byteLength) || (item.byteLength as number) < 0 ||
      typeof item.sha256 !== "string" || !sha256(item.sha256) || typeof item.content !== "string") {
      throw new Error("SKILL_RESOURCE_INVALID: bundle 文件结构无效");
    }
    return {
      path: item.path,
      encoding: "base64",
      byteLength: item.byteLength as number,
      sha256: item.sha256,
      content: item.content,
    };
  });
  return { schemaVersion: 1, kind: "mk-skill-bundle", name: value.name, contentHash: value.contentHash, files };
}

/** 读取「readBounded」所需数据，并遵守作用域、分页与容量边界。 */
async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new Error("SKILL_RESOURCE_INVALID: 响应体过大");
  if (!response.body) throw new Error("SKILL_RESOURCE_INVALID: 响应没有 Body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("SKILL_RESOURCE_INVALID: 响应体过大");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** 根据受控标识构造「safeRelativePath」路径；调用方仍须执行归属与目录边界校验。 */
function safeRelativePath(value: string): string {
  if (!value || value.includes("\\") || value.startsWith("/") || value.includes("\0")) {
    throw new Error(`SKILL_RESOURCE_INVALID: 文件路径无效 ${value}`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`SKILL_RESOURCE_INVALID: 文件路径越界 ${value}`);
  }
  return normalized;
}

/** 校验并规范化「decodeBase64」输入，非法数据直接返回明确错误。 */
function decodeBase64(value: string, path: string): Buffer {
  if (!validBase64(value)) {
    throw new Error(`SKILL_RESOURCE_INVALID: ${path} 不是规范 Base64`);
  }
  return Buffer.from(value, "base64");
}

/** 大型二进制资源不能交给回溯正则；逐字符校验可保持固定调用栈和同等格式约束。 */
function validBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  let contentEnd = value.length;
  while (contentEnd > 0 && value.charCodeAt(contentEnd - 1) === 61) contentEnd -= 1;
  const padding = value.length - contentEnd;
  if (padding > 2 || (padding === 1 && contentEnd % 4 !== 3) || (padding === 2 && contentEnd % 4 !== 2)) return false;
  for (let index = 0; index < contentEnd; index += 1) {
    const code = value.charCodeAt(index);
    const alphabet = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47;
    if (!alphabet) return false;
  }
  return true;
}

/** 执行「sha256」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function sha256(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
/** 更新「record」对应状态，并保持写入顺序、原子性与容量约束。 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
