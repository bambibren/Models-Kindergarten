import type { PptxPlaybackResponse } from "@kindergarten/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  onlyOfficeEditorConfig,
  onlyOfficePreloadUrl,
  onlyOfficeWarmupKey,
} from "./onlyoffice-runtime.js";

describe("ONLYOFFICE browser runtime", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("从版本无关的 API 地址派生官方 preload 页面", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(onlyOfficePreloadUrl("https://office.example.test/web-apps/apps/api/documents/api.js"))
      .toBe("https://office.example.test/web-apps/apps/api/documents/preload.html");
    expect(onlyOfficePreloadUrl("https://office.example.test/9.4.0/web-apps/apps/api/documents/api.js?cache=1"))
      .toBe("https://office.example.test/9.4.0/web-apps/apps/api/documents/preload.html");
  });

  it("只用 document ready 宣告可播放，并保留服务端签名配置", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const onDocumentReady = vi.fn();
    const onError = vi.fn();
    const config = playback().config;

    const result = onlyOfficeEditorConfig(config, { onDocumentReady, onError });

    expect(result).toMatchObject({
      ...config,
      width: "100%",
      height: "100%",
      events: { onDocumentReady, onError },
    });
    expect(Object.keys(result.events as object)).toEqual(["onDocumentReady", "onError"]);
    expect(result).not.toHaveProperty("events.onAppReady");
  });

  it("同一文档版本在当前页面内共享预热身份，document key 变化后重新预热", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
  () => {
    const first = playback();
    const sameVersion = playback();
    const nextVersion = playback();
    nextVersion.config.document.key = "artifact-version-key-v2";

    expect(onlyOfficeWarmupKey(sameVersion)).toBe(onlyOfficeWarmupKey(first));
    expect(onlyOfficeWarmupKey(nextVersion)).not.toBe(onlyOfficeWarmupKey(first));
  });
});

/** 构造稳定的播放配置，测试只关注浏览器 Runtime 如何消费服务端合同。 */
function playback(): PptxPlaybackResponse {
  return {
    documentServerApiUrl: "https://office.example.test/web-apps/apps/api/documents/api.js",
    config: {
      type: "embedded",
      documentType: "slide",
      document: {
        fileType: "pptx",
        key: "artifact-version-key",
        title: "deck.pptx",
        url: "https://runtime.example.test/deck.pptx?token=signed",
        permissions: { download: false, edit: false, print: false },
      },
      editorConfig: {
        lang: "zh-CN",
        mode: "view",
        customization: {
          compactHeader: true,
          hideRightMenu: true,
          toolbarHideFileName: true,
        },
        embedded: { autostart: "player", toolbarDocked: "bottom" },
      },
      token: "signed-config",
    },
  };
}
