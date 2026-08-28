import { describe, expect, it, vi } from "vitest";
import type { PptxBuildResult } from "../../src/pptx/pptx-build-service.js";
import {
  PPTX_TOOL_IDS,
  PptxToolProvider,
  type PptxBuilder,
} from "../../src/pptx/pptx-tool-provider.js";
import { ToolCallLedger, ToolRuntime } from "../../src/tools/tool-runtime.js";

describe("PptxToolProvider", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("只暴露 build_pptx，参数不接受命令、URL 或附属输出", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(PPTX_TOOL_IDS).toEqual(["build_pptx"]);
    const provider = new PptxToolProvider(builder(), bindings("allow"));
    const definition = provider.definitions[0]?.function;
    expect(definition?.name).toBe("build_pptx");
    expect(definition?.description).toContain("运行环境已提供 PptxGenJS 4.0.1");
    expect(definition?.description).toContain("不要创建 package.json");
    expect(definition?.description).toContain("不要安装依赖");
    expect(definition?.description).toContain("不要为构建 PPTX 请求终端权限");
    expect(definition?.parameters.properties).toEqual({
      source_path: expect.any(Object),
      output_path: expect.any(Object),
    });
    expect(JSON.stringify(definition)).not.toMatch(/command|url|pdf|png|report/i);
  });

  it("permission=allow 时不询问，结果只指向 Workspace 中的 PPTX", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const build = vi.fn(/** 构造「build」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => buildResult());
    const provider = new PptxToolProvider({ build }, bindings("allow"));
    const call = provider.prepare({
      id: "build-1",
      name: "build_pptx",
      arguments: { source_path: "deck/generate.cjs", output_path: "deck/final.pptx" },
    }, "fallback");
    expect(call.retry).toBe("none");
    expect(call.permission).toBe("allow");
    expect(call.locations).toEqual([]);
    const requestPermission = vi.fn(/** 构造「requestPermission」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => true);
    const batch = await new ToolRuntime(provider).executeBatch([call], {
      toolStart: /** 构造「toolStart」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
      toolFinish: /** 构造「toolFinish」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
      requestPermission,
      askUser: /** 构造「askUser」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => "",
    }, new ToolCallLedger(), new AbortController().signal);

    expect(requestPermission).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledOnce();
    expect(batch.outcomes[0]).toMatchObject({
      status: "success",
      locations: [],
      effects: { fileRelativePaths: ["deck/final.pptx"] },
      rawOutput: { outputPath: "deck/final.pptx", slides: 3 },
    });
    expect(batch.outcomes[0]?.content).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.objectContaining({ type: "resource_link" }) }),
    ]));
    expect(batch.outcomes[0]?.modelContent).toContain("not yet deliverable");
  });

  it("未启用时不进入模型 Schema，参数错误在执行前失败", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const disabled = new PptxToolProvider(builder(), new Map());
    expect(disabled.definitions).toEqual([]);
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => disabled.prepare({
      name: "build_pptx",
      arguments: { source_path: "deck/source.txt", output_path: "deck/final.pptx" },
    }, "fallback")).toThrow("未启用");

    const enabled = new PptxToolProvider(builder(), bindings("allow"));
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => enabled.prepare({
      name: "build_pptx",
      arguments: { source_path: "", output_path: "deck/final.pptx" },
    }, "fallback")).toThrow("source_path");
  });
});

/** 构造「bindings」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function bindings(permission: "allow" | "ask" | "deny") {
  return new Map([["build_pptx", { enabled: true, permission }]]);
}

/** 构造「builder」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function builder(): PptxBuilder {
  return { build: /** 构造「build」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => buildResult() };
}

/** 构造「buildResult」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function buildResult(): PptxBuildResult {
  return {
    sourcePath: "deck/generate.cjs",
    outputPath: "deck/final.pptx",
    sha256: "a".repeat(64),
    byteLength: 12_345,
    slides: 3,
    entries: 20,
    stdout: "",
    stderr: "",
    truncated: false,
  };
}
