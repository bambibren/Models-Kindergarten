import { ProductNav } from "./ProductNav.js";
import { SkillMarket } from "./SkillMarket.js";

/** Skill 市场使用独立受认证路由，静态目录读取和账号安装仍由 SkillMarket 分别处理。 */
export function SkillMarketPage() {
  return <main className="product-page">
    <ProductNav active="skills" />
    <div className="product-skill-market-page"><SkillMarket /></div>
  </main>;
}
