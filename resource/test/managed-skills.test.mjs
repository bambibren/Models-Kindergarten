import assert from "node:assert/strict";
import { test } from "node:test";
import { assertManagedSkillBundle, assertManagedSkillNames } from "../managed-skills.mjs";

test("受管 Skill 发布集合必须完整且不夹带额外目录", () => {
  const expected = ["pptx", "website-design-fast"];
  assert.doesNotThrow(() => assertManagedSkillNames(["website-design-fast", "pptx"], expected));
  assert.throws(() => assertManagedSkillNames(["pptx"], expected), /website-design-fast/u);
  assert.throws(() => assertManagedSkillNames(["pptx", "website-design-fast", "unknown"], expected), /unknown/u);
});

test("受管 Skill Bundle 必须包含 SKILL.md", () => {
  assert.doesNotThrow(() => assertManagedSkillBundle({
    schemaVersion: 1,
    kind: "mk-skill-bundle",
    name: "pptx",
    files: [{ path: "SKILL.md", content: "encoded" }],
  }, "pptx"));
  assert.throws(() => assertManagedSkillBundle({
    schemaVersion: 1,
    kind: "mk-skill-bundle",
    name: "pptx",
    files: [],
  }, "pptx"), /SKILL\.md/u);
});
