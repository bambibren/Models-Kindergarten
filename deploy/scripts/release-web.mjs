import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertManagedSkillBundle,
  assertManagedSkillNames,
  readManagedSkillNames,
} from "../../resource/managed-skills.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const imageRepository = "ghcr.io/bambibren/models-kindergarten/mk-web";
const configFile = resolve(repoRoot, "deploy/managed-web-skills.json");
const relevantPaths = [
  ".dockerignore", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "apps/web", "packages/contracts", "packages/evaluation-contract", "packages/runtime-observation",
  "resource/export-static.mjs", "resource/managed-skills.mjs", "resource/server.mjs", "resource/package.json",
  "deploy/Caddyfile", "deploy/images/Dockerfile.web", "deploy/managed-web-skills.json",
];

await main();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checkOnly = args.has("check");
  if (!checkOnly) validateReleaseState();

  const expected = await readManagedSkillNames(configFile);
  await validateLocalSkills(expected);
  const temp = await mkdtemp(join(tmpdir(), "mk-web-release-"));
  const source = join(temp, "source");
  let worktreeCreated = false;
  try {
    run("git", ["worktree", "add", "--detach", source, "HEAD"], repoRoot);
    worktreeCreated = true;
    for (const name of expected) {
      await cp(resolve(repoRoot, "resource/skills", name), resolve(source, "resource/skills", name), { recursive: true });
    }
    await verifyStagedExport(source, temp, expected);
    if (checkOnly) {
      console.log(`Web 发布输入检查通过：${expected.join(", ")}`);
      return;
    }

    const release = required(args, "release");
    const baseManifestFile = resolve(repoRoot, required(args, "base-manifest"));
    const commit = capture("git", ["rev-parse", "HEAD"], repoRoot).trim();
    const shortCommit = capture("git", ["rev-parse", "--short=7", "HEAD"], repoRoot).trim();
    const tag = releaseTag(release);
    if (!tag.startsWith(shortCommit)) throw new Error(`release 必须以当前提交 ${shortCommit} 开头`);
    const image = `${imageRepository}:${tag}`;

    run("docker", [
      "buildx", "build", "--platform", "linux/amd64",
      "--file", "deploy/images/Dockerfile.web",
      "--tag", image, "--provenance=true", "--push", ".",
    ], source);
    const digest = imageDigest(image);
    const pinnedImage = `${imageRepository}@${digest}`;
    await verifyPublishedImage(pinnedImage, expected);
    const manifest = await makeManifest(baseManifestFile, release, commit, pinnedImage);
    const manifestFile = resolve(repoRoot, "deploy/releases", release, "release-manifest.json");
    await mkdir(dirname(manifestFile), { recursive: true });
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(`Web 镜像发布并验收通过：${pinnedImage}`);
    console.log(`Release manifest 已生成：${manifestFile}`);
  } finally {
    if (worktreeCreated) run("git", ["worktree", "remove", "--force", source], repoRoot, false);
    await rm(temp, { recursive: true, force: true });
  }
}

function validateReleaseState() {
  const branch = capture("git", ["branch", "--show-current"], repoRoot).trim();
  if (branch !== "main") throw new Error("正式 Web 发布只允许从 main 分支执行");
  const dirty = capture("git", ["status", "--porcelain", "--untracked-files=no", "--", ...relevantPaths], repoRoot).trim();
  if (dirty) throw new Error(`Web 发布相关文件尚未提交：\n${dirty}`);
  const head = capture("git", ["rev-parse", "HEAD"], repoRoot).trim();
  const remoteMain = capture("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"], repoRoot).trim().split(/\s+/u)[0];
  if (remoteMain !== head) throw new Error("当前 main HEAD 尚未完整推送到 origin/main");
}

async function validateLocalSkills(expected) {
  const root = resolve(repoRoot, "resource/skills");
  const actual = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assertManagedSkillNames(actual, expected, "本机受管 Skill 源目录");
  for (const name of expected) await readFile(resolve(root, name, "SKILL.md"), "utf8");
}

async function verifyStagedExport(source, temp, expected) {
  const output = resolve(temp, "export-check");
  run("node", ["resource/export-static.mjs", output], source, true, {
    MK_REQUIRED_SKILLS_FILE: resolve(source, "deploy/managed-web-skills.json"),
  });
  const index = JSON.parse(await readFile(resolve(output, "skills/index.json"), "utf8"));
  assertManagedSkillNames(index.skills.map((skill) => skill.name), expected, "暂存导出 Skill");
  for (const name of expected) {
    assertManagedSkillBundle(JSON.parse(await readFile(resolve(output, `skills/${name}.json`), "utf8")), name);
  }
}

async function verifyPublishedImage(image, expected) {
  const index = JSON.parse(capture("docker", [
    "run", "--rm", "--pull=always", "--platform", "linux/amd64", "--entrypoint", "cat",
    image, "/srv/skills/index.json",
  ], repoRoot));
  assertManagedSkillNames(index.skills.map((skill) => skill.name), expected, "镜像内受管 Skill");
  for (const name of expected) {
    const bundle = JSON.parse(capture("docker", [
      "run", "--rm", "--platform", "linux/amd64", "--entrypoint", "cat",
      image, `/srv/skills/${name}.json`,
    ], repoRoot));
    assertManagedSkillBundle(bundle, name);
  }
}

function imageDigest(image) {
  const output = capture("docker", ["buildx", "imagetools", "inspect", image], repoRoot);
  const digest = output.match(/^Digest:\s+(sha256:[a-f0-9]{64})$/mu)?.[1];
  if (!digest) throw new Error("无法读取推送后的 Web 镜像摘要");
  return digest;
}

async function makeManifest(file, release, commit, webImage) {
  const base = JSON.parse(await readFile(file, "utf8"));
  if (!base || base.schemaVersion !== 1 || !base.images) throw new Error("基础 release manifest 结构无效");
  for (const key of ["runtime", "onlyoffice"]) {
    if (typeof base.images[key] !== "string" || !/@sha256:[a-f0-9]{64}$/u.test(base.images[key])) {
      throw new Error(`基础 release manifest 缺少锁定摘要的 ${key} 镜像`);
    }
  }
  return {
    schemaVersion: 1,
    release,
    gitCommit: commit,
    dataCompatibilityVersion: base.dataCompatibilityVersion ?? 1,
    images: { web: webImage, runtime: base.images.runtime, onlyoffice: base.images.onlyoffice },
  };
}

function releaseTag(release) {
  const match = release.match(/^\d{4}-\d{2}-\d{2}-([A-Za-z0-9._-]+)$/u);
  if (!match) throw new Error("release 必须使用 YYYY-MM-DD-镜像标签 格式");
  return match[1];
}

function parseArgs(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) throw new Error(`无法识别参数：${token ?? ""}`);
    const key = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) result.set(key, true);
    else { result.set(key, next); index += 1; }
  }
  return result;
}

function required(values, key) {
  const value = values.get(key);
  if (typeof value !== "string" || !value) throw new Error(`缺少 --${key}`);
  return value;
}

function run(command, args, cwd, inherit = true, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: inherit ? "inherit" : "ignore",
  });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} 执行失败`);
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `${command} ${args[0] ?? ""} 执行失败`);
  return result.stdout;
}
