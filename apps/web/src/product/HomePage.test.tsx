import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HomeCapabilities, pptPrompt, websitePrompt } from "./HomePage.js";

describe("production home page capabilities", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("places website development first", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<HomeCapabilities onSelectPptx={/** 构造「onSelectPptx」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined} onSelectWebsite={/** 构造「onSelectWebsite」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined} />);
    expect(html.indexOf("网站开发")).toBeLessThan(html.indexOf("PPT 制作"));
    expect(html.indexOf("PPT 制作")).toBeLessThan(html.indexOf("模型上下文实验"));
    expect(html).toContain("模型上下文实验（功能调研中）");
    expect(html).not.toContain("href=\"/context-lab\"");
  });

  it("uses the requested website task prompt verbatim", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(websitePrompt).toBe(`请先把以下 Skills 安装到当前 Agent 并自动启用，全部就绪后再开始任务：
http://127.0.0.1:5173/skills/website-design-fast

请制作一个气泡水网站，风格是幼稚可爱清新活泼，气泡水有四种口味：葡萄、橙子、海盐、青柠。首屏的大slogan是“快来一起做汽水课间操！”，背景需要有淡化不喧宾夺主的动效。然后后面几屏需要展示不同口味气泡水瓶的介绍，需要气泡水瓶内的水随鼠标反馈可以做液体运动。还需要展示网页互动小游戏，吸引学生群体。`);
  });

  it("uses the requested pptx task prompt verbatim", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(pptPrompt).toBe(`运用 http://127.0.0.1:5173/skills/pptx skill

帮我给旺仔QQ糖只做一篇全口味宣传的PPT，要从同年回忆小故事、口味联想、情绪价值和针对受众群体喜好的宣传活动。`);
  });
});
