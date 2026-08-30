import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const defaultSkillsRoot = resolve(projectRoot, "skills");
const maxFiles = 200;
const maxTotalBytes = 2 * 1024 * 1024;

export function createResourceServer(options = {}) {
  const skillsRoot = resolve(options.skillsRoot ?? defaultSkillsRoot);
  return createServer(async (request, response) => {
    try {
      if (request.method !== "GET") return send(response, 405, { error: "METHOD_NOT_ALLOWED" });
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health") return send(response, 200, { ok: true });
      if (url.pathname === "/skills") {
        const skills = await listSkills(skillsRoot);
        return send(response, 200, { schemaVersion: 1, skills });
      }
      const match = url.pathname.match(/^\/skills\/([a-z0-9-]+)$/);
      if (!match) return send(response, 404, { error: "NOT_FOUND" });
      const bundle = await buildSkillBundle(skillsRoot, match[1]);
      const etag = `"${bundle.contentHash}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag });
        return response.end();
      }
      return send(response, 200, bundle, {
        "content-type": "application/vnd.mk.skill+json; charset=utf-8",
        etag,
        "cache-control": "no-cache",
      });
    } catch (error) {
      const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
      return send(response, missing ? 404 : 500, {
        error: missing ? "SKILL_NOT_FOUND" : "RESOURCE_SERVER_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export async function buildSkillBundle(skillsRoot, name) {
  assertSkillName(name);
  const root = resolve(skillsRoot, name);
  const skillsReal = await realpath(skillsRoot);
  const rootReal = await realpath(root);
  assertInside(skillsReal, rootReal);
  const collected = await collectFiles(rootReal);
  if (!collected.some((file) => file.path === "SKILL.md")) {
    throw new Error(`Skill ${name} 缺少 SKILL.md`);
  }
  const contentHash = createHash("sha256");
  const files = [];
  for (const item of collected.toSorted((left, right) => left.path.localeCompare(right.path))) {
    const bytes = await readFile(item.absolutePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    contentHash.update(item.path).update("\0").update(bytes).update("\0");
    files.push({
      path: item.path,
      encoding: "base64",
      byteLength: bytes.byteLength,
      sha256,
      content: bytes.toString("base64"),
    });
  }
  return {
    schemaVersion: 1,
    kind: "mk-skill-bundle",
    name,
    contentHash: contentHash.digest("hex"),
    files,
  };
}

/** 把运行时资源协议预生成成静态 JSON，使 Caddy 无需额外 Node 进程即可提供同一组 URL。 */
export async function exportStaticResourceSite(skillsRoot, outputRoot) {
  const root = resolve(skillsRoot);
  const target = resolve(outputRoot, "skills");
  const skills = await listSkills(root);
  await mkdir(target, { recursive: true });
  await writeJson(resolve(target, "index.json"), { schemaVersion: 1, skills });
  for (const skill of skills) {
    await writeJson(resolve(target, `${skill.name}.json`), await buildSkillBundle(root, skill.name));
  }
  return skills.map((skill) => skill.name);
}

async function listSkills(skillsRoot) {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name))
    .map((entry) => ({ name: entry.name, url: `/skills/${entry.name}` }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

async function collectFiles(root) {
  const files = [];
  let totalBytes = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) throw new Error(`Skill 不允许符号链接: ${entry.name}`);
      if (info.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!info.isFile()) throw new Error(`Skill 包含不支持的文件类型: ${entry.name}`);
      totalBytes += info.size;
      if (totalBytes > maxTotalBytes) throw new Error(`Skill 总大小超过 ${maxTotalBytes} 字节`);
      files.push({
        absolutePath,
        path: relative(root, absolutePath).split(sep).join("/"),
      });
      if (files.length > maxFiles) throw new Error(`Skill 文件数超过 ${maxFiles}`);
    }
  }
  await walk(root);
  return files;
}

function assertSkillName(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Skill name 必须使用小写字母、数字和连字符");
}

function assertInside(root, target) {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Skill 路径越界");
}

function send(response, status, value, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    ...headers,
  });
  response.end(body);
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? "7342");
  if (!isLoopback(host)) throw new Error("MK Resource 当前只允许监听本机回环地址");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT 必须是有效端口");
  const server = createResourceServer();
  server.listen(port, host, () => {
    console.log(`MK Resource: http://${host}:${port}`);
  });
}
