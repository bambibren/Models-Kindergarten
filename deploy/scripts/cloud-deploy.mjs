import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [mode, ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);
const dryRun = args.has("dry-run");

if (mode !== "ip" && mode !== "domain") fail("部署模式必须是 ip 或 domain");
const server = required(args, "server");
const manifestFile = resolve(repoRoot, required(args, "manifest"));
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
validateManifest(manifest);

const release = safeSegment(manifest.release, "release");
const remoteRelease = `/srv/mk/releases/${release}`;
const settings = mode === "ip" ? ipSettings(args) : domainSettings(args);
if (mode === "domain" && !dryRun && !args.has("confirm-production-ready")) {
  fail("正式域名部署必须在生产认证和 ONLYOFFICE JWT 验收后显式传入 --confirm-production-ready");
}
const temp = await mkdtemp(join(tmpdir(), "mk-cloud-deploy-"));

try {
  const envFile = join(temp, "release.env");
  await writeFile(envFile, renderEnv({
    COMPOSE_PROJECT_NAME: "mk",
    DEPLOYMENT_PROFILE: "cloud",
    AUTH_MODE: settings.authMode,
    PUBLIC_ORIGIN: settings.publicOrigin,
    ONLYOFFICE_PUBLIC_URL: settings.officeOrigin,
    MK_SITE_ADDRESS: settings.siteAddress,
    MK_OFFICE_SITE_ADDRESS: settings.officeSiteAddress,
    MK_HTTP_BIND: "0.0.0.0",
    MK_HTTP_PORT: "80",
    MK_OFFICE_BIND: settings.officeBind,
    MK_OFFICE_PORT: "8080",
    MK_HTTPS_BIND: settings.httpsBind,
    MK_HTTPS_PORT: settings.httpsPort,
    MK_DATA_PATH: "/srv/mk/data/app",
    MK_MASTER_KEY_FILE: "/srv/mk/secrets/mk_master_key",
    MK_WEB_IMAGE: manifest.images.web,
    MK_RUNTIME_IMAGE: manifest.images.runtime,
    ONLYOFFICE_IMAGE: manifest.images.onlyoffice,
    ONLYOFFICE_JWT_ENABLED: settings.jwtEnabled,
    ALLOW_INSECURE_SKILL_RESOURCE_ORIGINS: settings.allowInsecureSkillResourceOrigins,
  }), "utf8");

  run("ssh", [server, bootstrapCommand(remoteRelease)], dryRun);
  run("scp", [
    resolve(repoRoot, "deploy/compose.yaml"),
    envFile,
    manifestFile,
    `${server}:${remoteRelease}/`,
  ], dryRun);
  run("ssh", [server, remoteDeployCommand(remoteRelease, basename(manifestFile), settings)], dryRun);
  console.log(`${mode === "ip" ? "公网 IP" : "正式域名"}部署命令已${dryRun ? "生成" : "执行"}：${settings.publicOrigin}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}

function ipSettings(values) {
  const ip = required(values, "ip");
  if (!isPublicIpv4(ip)) fail("--ip 必须是可公开访问的 IPv4 地址");
  if (!values.has("allow-http-preview") && !dryRun) {
    fail("公网 IP 阶段是临时 HTTP 验收，必须显式传入 --allow-http-preview");
  }
  return {
    authMode: "development",
    publicOrigin: `http://${ip}`,
    officeOrigin: `http://${ip}:8080`,
    siteAddress: "http://:8080",
    officeSiteAddress: "http://:8081",
    officeBind: "0.0.0.0",
    httpsBind: "127.0.0.1",
    httpsPort: "7443",
    jwtEnabled: "false",
    allowInsecureSkillResourceOrigins: "true",
    probe: `http://${ip}/health/ready`,
  };
}

function domainSettings(values) {
  const domain = hostname(required(values, "domain"), "--domain");
  const officeDomain = hostname(required(values, "office-domain"), "--office-domain");
  if (domain === officeDomain) fail("主域名和 ONLYOFFICE 域名必须不同");
  return {
    authMode: "required",
    publicOrigin: `https://${domain}`,
    officeOrigin: `https://${officeDomain}`,
    siteAddress: domain,
    officeSiteAddress: officeDomain,
    officeBind: "127.0.0.1",
    httpsBind: "0.0.0.0",
    httpsPort: "443",
    jwtEnabled: "true",
    allowInsecureSkillResourceOrigins: "false",
    probe: `https://${domain}/health/ready`,
  };
}

function bootstrapCommand(remoteRelease) {
  return [
    "set -eu",
    "command -v docker >/dev/null",
    "docker compose version >/dev/null",
    "sudo install -d -m 0750 /srv/mk/data",
    "sudo install -d -m 0700 /srv/mk/secrets",
    "sudo install -d -m 0700 -o 10001 -g 10001 /srv/mk/data/app",
    "sudo install -d -m 0750 -o ubuntu -g ubuntu /srv/mk/backups",
    `mkdir -p ${quote(remoteRelease)}`,
    "if ! sudo test -f /srv/mk/secrets/mk_master_key; then sudo sh -c 'umask 077; openssl rand -base64 32 > /srv/mk/secrets/mk_master_key'; fi",
    "sudo chown 10001:10001 /srv/mk/secrets/mk_master_key",
    "sudo chmod 600 /srv/mk/secrets/mk_master_key",
    "sudo sh -c 'test \"$(wc -c < /srv/mk/secrets/mk_master_key)\" -eq 45'",
  ].join("; ");
}

function remoteDeployCommand(remoteRelease, manifestName, settings) {
  const compose = "docker compose --env-file release.env -f compose.yaml";
  return [
    "set -eu",
    `cd ${quote(remoteRelease)}`,
    `test -f ${quote(manifestName)}`,
    "sudo test -r /srv/mk/secrets/mk_master_key",
    "if [ -d /srv/mk/data/app ] && [ \"$(sudo find /srv/mk/data/app -mindepth 1 -maxdepth 1 -print -quit)\" ]; then sudo tar -C /srv/mk/data -czf /srv/mk/backups/pre-deploy-$(date +%Y%m%d%H%M%S).tgz app; fi",
    `${compose} pull`,
    `${compose} up --detach --no-build --wait --wait-timeout 420`,
    `curl --fail --silent --show-error ${quote(settings.probe)} >/dev/null`,
  ].join("; ");
}

function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.release !== "string" || !value.images) {
    fail("release manifest 结构无效");
  }
  for (const key of ["web", "runtime", "onlyoffice"]) {
    const image = value.images[key];
    if (typeof image !== "string" || !/@sha256:[a-f0-9]{64}$/u.test(image)) {
      fail(`release manifest 的 ${key} 必须锁定 sha256 摘要`);
    }
  }
}

function renderEnv(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (token === "--") continue;
    if (!token?.startsWith("--")) fail(`无法识别参数：${token ?? ""}`);
    const key = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) parsed.set(key, true);
    else { parsed.set(key, next); index += 1; }
  }
  return parsed;
}

function required(values, key) {
  const value = values.get(key);
  if (typeof value !== "string" || value === "") fail(`缺少 --${key}`);
  return value;
}

function hostname(value, label) {
  let url;
  try { url = new URL(`https://${value}`); }
  catch { fail(`${label} 必须是有效域名`); }
  if (url.hostname !== value || !value.includes(".") || url.port || url.pathname !== "/") fail(`${label} 必须是纯域名`);
  return value;
}

function isPublicIpv4(value) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
}

function safeSegment(value, label) {
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) fail(`${label} 只能包含字母、数字、点、下划线和连字符`);
  return value;
}

function run(command, values, printOnly) {
  if (printOnly) {
    console.log([command, ...values].map(quote).join(" "));
    return;
  }
  const result = spawnSync(command, values, { stdio: "inherit" });
  if (result.status !== 0) fail(`${command} 执行失败`);
}

function quote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function fail(message) {
  throw new Error(message);
}
