import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const file = resolve(repoRoot, process.argv[2] ?? "deploy/local/secrets/mk_master_key");
const pattern = /^[A-Za-z0-9+/]{43}=$/u;

await mkdir(dirname(file), { recursive: true, mode: 0o700 });
try {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(`${randomBytes(32).toString("base64")}\n`, "utf8"); }
  finally { await handle.close(); }
  await chmod(file, 0o600);
  console.log(`已创建 Docker 预演主密钥：${file}`);
} catch (error) {
  if (!isExists(error)) throw error;
  const metadata = await lstat(file);
  const encoded = (await readFile(file, "utf8")).trim();
  if (!metadata.isFile() || metadata.isSymbolicLink() || !pattern.test(encoded)) {
    throw new Error(`已有主密钥文件无效，拒绝覆盖：${file}`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`已有主密钥权限必须是 0400 或 0600：${file}`);
  }
  console.log(`复用已有 Docker 预演主密钥：${file}`);
}

function isExists(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
