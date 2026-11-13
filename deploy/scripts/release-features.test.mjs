import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveContextExperiments } from "./release-features.mjs";

test("普通发布保留上一版已经开启的上下文实验", () => {
  assert.equal(resolveContextExperiments(true), true);
});

test("普通发布也保留显式关闭状态", () => {
  assert.equal(resolveContextExperiments(false), false);
});

test("历史清单缺少功能记录时停止发布，不再默认关闭", () => {
  assert.throws(() => resolveContextExperiments(undefined), /基础 manifest 未记录/);
});

test("显式开启可迁移历史清单或覆盖关闭状态", () => {
  assert.equal(resolveContextExperiments(undefined, { enable: true }), true);
  assert.equal(resolveContextExperiments(false, { enable: true }), true);
});

test("显式关闭可以覆盖已开启状态", () => {
  assert.equal(resolveContextExperiments(true, { disable: true }), false);
});

test("互相矛盾的开关必须报错", () => {
  assert.throws(() => resolveContextExperiments(true, { enable: true, disable: true }), /不能同时/);
});
