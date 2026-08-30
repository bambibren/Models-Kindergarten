import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const profile = JSON.parse(await readFile(resolve(repoRoot, "deploy/pptx-worker-seccomp.json"), "utf8"));

assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
assert.equal(profile.defaultErrnoRet, 1);
assert.ok(Array.isArray(profile.archMap) && profile.archMap.length > 0);
assert.ok(Array.isArray(profile.syscalls) && profile.syscalls.length > 0);

const exactNamespaceRule = profile.syscalls.filter((rule) =>
  rule.action === "SCMP_ACT_ALLOW" &&
  Array.isArray(rule.names) && rule.names.length === 1 && rule.names[0] === "unshare" &&
  Array.isArray(rule.args) && rule.args.length === 1 &&
  rule.args[0]?.index === 0 &&
  rule.args[0]?.op === "SCMP_CMP_EQ" &&
  rule.args[0]?.value === 0x10000000 + 0x40000000);
assert.equal(exactNamespaceRule.length, 1, "必须且只能精确放行 CLONE_NEWUSER | CLONE_NEWNET");

for (const name of ["bpf", "mount", "setns", "socket"]) {
  assert.equal(profile.syscalls.some((rule) =>
    rule.action === "SCMP_ACT_ALLOW" &&
    !rule.includes && !rule.excludes &&
    (!Array.isArray(rule.args) || rule.args.length === 0) &&
    rule.names?.includes(name)), false, `${name} 不得无条件放行`);
}

assert.ok(profile.syscalls.some((rule) =>
  rule.action === "SCMP_ACT_ALLOW" &&
  rule.names?.includes("unshare") &&
  rule.includes?.caps?.includes("CAP_SYS_ADMIN")), "必须保留 Docker 默认的 capability gate");

process.stdout.write("PPTX seccomp profile 校验通过\n");
