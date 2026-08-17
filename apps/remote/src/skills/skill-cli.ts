import { resolve } from "node:path";
import { SkillInstaller } from "./skill-installer.js";
import { SkillLockStore } from "./skill-lock-store.js";
import { configuredSkillResourceOrigins, SkillSourceUrlPolicy } from "./skill-source-url.js";
import type { SkillInstallRequest } from "./skill-types.js";

const args = parseArgs(process.argv.slice(2));
const dataDir = resolve(process.env.DATA_DIR ?? ".data");
const installer = new SkillInstaller(
  resolve(process.env.USER_SKILLS_DIR ?? `${dataDir}/skills`),
  new SkillLockStore(resolve(process.env.SKILLS_LOCK_FILE ?? `${dataDir}/skills-lock.json`)),
);
const sourcePolicy = new SkillSourceUrlPolicy(configuredSkillResourceOrigins(process.env.SKILL_RESOURCE_ORIGINS));
const request = installRequest(args, sourcePolicy);
const record = await installer.install(request);
console.log(JSON.stringify({
  installed: true,
  name: record.name,
  contentHash: record.contentHash,
  source: record.source,
}, null, 2));

function installRequest(args: Map<string, string | true>, sourcePolicy: SkillSourceUrlPolicy): SkillInstallRequest {
  if (args.get("approve") !== true) throw new Error("必须提供 --approve 明确确认安装");
  const source = required(args, "source");
  if (source === "local") {
    return {
      approved: true,
      source: { kind: "local", path: required(args, "path") },
    };
  }
  if (source === "git") {
    const subdir = stringValue(args.get("subdir"));
    return {
      approved: true,
      source: {
        kind: "git",
        url: required(args, "url"),
        ref: required(args, "ref"),
        ...(subdir ? { subdir } : {}),
      },
    };
  }
  if (source === "resource") {
    const parsed = sourcePolicy.parse(required(args, "url"));
    if (parsed.kind !== "resource") throw new Error("--source resource 必须使用已配置的静态资源地址");
    return {
      approved: true,
      source: { kind: "resource", url: parsed.sourceUrl },
    };
  }
  throw new Error("--source 必须是 local、git 或 resource");
}

function parseArgs(values: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) throw new Error(`未知参数: ${token}`);
    const key = token.slice(2);
    if (key === "approve") {
      result.set(key, true);
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} 缺少值`);
    result.set(key, value);
    index += 1;
  }
  return result;
}

function required(args: Map<string, string | true>, name: string): string {
  const value = stringValue(args.get(name));
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

function stringValue(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
