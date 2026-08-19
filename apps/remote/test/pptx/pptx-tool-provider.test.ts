import { describe, expect, it, vi } from "vitest";
import type { PptxBuildResult } from "../../src/pptx/pptx-build-service.js";
import {
  PPTX_TOOL_IDS,
  PptxToolProvider,
  type PptxBuilder,
} from "../../src/pptx/pptx-tool-provider.js";
import { ToolCallLedger, ToolRuntime } from "../../src/tools/tool-runtime.js";

describe("PptxToolProvider", () => {
  it("只暴露 build_pptx，参数不接受命令、URL 或附属输出", () => {
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

  it("permission=allow 时不询问，结果只指向 Workspace 中的 PPTX", async () => {
    const build = vi.fn(async () => buildResult());
    const provider = new PptxToolProvider({ build }, bindings("allow"));
    const call = provider.prepare({
      id: "build-1",
      name: "build_pptx",
      arguments: { source_path: "deck/generate.cjs", output_path: "deck/final.pptx" },
    }, "fallback");
    expect(call.retry).toBe("none");
    expect(call.permission).toBe("allow");
    expect(call.locations).toEqual([]);
    const requestPermission = vi.fn(async () => true);
    const batch = await new ToolRuntime(provider).executeBatch([call], {
      toolStart: async () => undefined,
      toolFinish: async () => undefined,
      requestPermission,
      askUser: async () => "",
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

  it("未启用时不进入模型 Schema，参数错误在执行前失败", () => {
    const disabled = new PptxToolProvider(builder(), new Map());
    expect(disabled.definitions).toEqual([]);
    expect(() => disabled.prepare({
      name: "build_pptx",
      arguments: { source_path: "deck/source.txt", output_path: "deck/final.pptx" },
    }, "fallback")).toThrow("未启用");

    const enabled = new PptxToolProvider(builder(), bindings("allow"));
    expect(() => enabled.prepare({
      name: "build_pptx",
      arguments: { source_path: "", output_path: "deck/final.pptx" },
    }, "fallback")).toThrow("source_path");
  });
});

function bindings(permission: "allow" | "ask" | "deny") {
  return new Map([["build_pptx", { enabled: true, permission }]]);
}

function builder(): PptxBuilder {
  return { build: async () => buildResult() };
}

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
