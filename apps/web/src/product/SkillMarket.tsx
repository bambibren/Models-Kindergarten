import { AlertCircle, BookOpen, Check, Copy, Download, LoaderCircle, RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SkillInstallJob, SkillInstallation } from "@kindergarten/contracts";
import { controlApi } from "../api/control-api.js";
import { filterSkillMarket, readSkillMarket, type SkillMarketEntry } from "../skills/skill-market-api.js";
import { publicSkillUrl } from "../skills/public-skill-url.js";
import { useResource } from "./use-resource.js";

const categoryOrder = ["产品方法", "设计与前端", "文档与数据", "视频与动效", "基础编排"];
const terminalJobStates = new Set<SkillInstallJob["state"]>(["succeeded", "failed", "cancelled", "interrupted"]);

type InstallAction = { phase: "installing" } | { phase: "failed"; message: string };

/** 首页市场只在 AuthGate 内挂载；目录读取与账号安装仍保持静态资源和 Control API 两条边界。 */
export function SkillMarket() {
  const load = useCallback(async () => {
    const [skills, installations] = await Promise.all([readSkillMarket(), controlApi.skills()]);
    return { skills, installations: installations.items };
  }, []);
  const { state, retry } = useResource(load);

  if (state.phase === "loading") return <SkillMarketLoading />;
  if (state.phase === "error") return <SkillMarketError message={state.message} retry={retry} />;
  return <SkillMarketReady installations={state.data.installations} skills={state.data.skills} />;
}

/** 渲染已取得真实目录和当前账号安装记录后的市场界面。 */
export function SkillMarketReady({ skills, installations }: {
  skills: SkillMarketEntry[];
  installations: SkillInstallation[];
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [actions, setActions] = useState<Record<string, InstallAction>>({});
  const [ownedNames, setOwnedNames] = useState(() => new Set(installations
    .filter((item) => item.state === "ready")
    .map((item) => item.skillName)));
  const [copiedName, setCopiedName] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<{ name: string; message: string } | null>(null);
  const copyTimer = useRef<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  const categories = useMemo(() => categoryOrder
    .filter((item) => skills.some((skill) => skill.category === item)), [skills]);
  const visible = useMemo(() => filterSkillMarket(skills, query, category), [category, query, skills]);

  const copy = async (skill: SkillMarketEntry) => {
    try {
      await copyText(publicSkillUrl(skill.name));
      if (!mounted.current) return;
      setCopyError(null);
      setCopiedName(skill.name);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedName(null), 1_800);
    } catch (error) {
      if (!mounted.current) return;
      setCopyError({ name: skill.name, message: error instanceof Error ? error.message : "复制失败" });
    }
  };

  const install = async (skill: SkillMarketEntry) => {
    if (ownedNames.has(skill.name) || actions[skill.name]?.phase === "installing") return;
    setActions((current) => ({ ...current, [skill.name]: { phase: "installing" } }));
    try {
      const initial = await controlApi.installSkills([publicSkillUrl(skill.name)]);
      const job = await waitForInstallJob(initial, () => mounted.current);
      if (!mounted.current) return;
      if (job.state !== "succeeded") {
        const detail = job.items.find((item) => item.error)?.error?.message;
        throw new Error(detail ?? `安装任务已${job.state === "interrupted" ? "中断" : "失败"}`);
      }
      setOwnedNames((current) => new Set(current).add(skill.name));
      setActions((current) => {
        const next = { ...current };
        delete next[skill.name];
        return next;
      });
    } catch (error) {
      if (!mounted.current) return;
      setActions((current) => ({
        ...current,
        [skill.name]: { phase: "failed", message: error instanceof Error ? error.message : "安装失败" },
      }));
    }
  };

  return <section className="product-skill-market" id="skill-market">
    <header className="product-skill-market-heading">
      <div><span>ACCOUNT · SKILLS MARKET</span><h2>给 ModelStudent 加一门新课</h2><p>浏览 MK 已发布的 Skill。复制资源地址，或直接安装到当前登录账号；安装后可在 Agent 配置中启用。</p></div>
      <strong><b>{skills.length}</b><small>个可用 Skill</small></strong>
    </header>
    <div className="product-skill-market-toolbar">
      <label><Search size={14} /><input aria-label="搜索 Skill" onChange={(event) => setQuery(event.target.value)} placeholder="搜索中文名称、介绍或资源名" type="search" value={query} /></label>
      <div aria-label="按 Skill 分类筛选" className="product-skill-categories">
        {["全部", ...categories].map((item) => {
          const count = item === "全部" ? skills.length : skills.filter((skill) => skill.category === item).length;
          return <button aria-pressed={category === item} className={category === item ? "active" : ""} key={item} onClick={() => setCategory(item)} type="button">{item}<small>{count}</small></button>;
        })}
      </div>
    </div>
    {visible.length === 0
      ? <div className="product-skill-market-empty"><BookOpen size={18} /><strong>没有匹配的 Skill</strong><p>换一个关键词或分类再试。</p></div>
      : <div className="product-skill-grid">{visible.map((skill) => {
        const owned = ownedNames.has(skill.name);
        const action = actions[skill.name];
        const installing = action?.phase === "installing";
        return <article key={skill.name}>
          <header><span><BookOpen size={16} /></span><div><h3>{skill.displayName}</h3><code>{skill.name}</code></div></header>
          <p>{skill.description}</p>
          <footer><span>{skill.category}</span><div>
            <button className="secondary" onClick={() => void copy(skill)} type="button"><Copy size={12} />{copiedName === skill.name ? "已复制" : "复制地址"}</button>
            <button disabled={owned || installing} onClick={() => void install(skill)} type="button">
              {owned ? <Check size={12} /> : installing ? <LoaderCircle className="spin" size={12} /> : action?.phase === "failed" ? <RotateCcw size={12} /> : <Download size={12} />}
              {owned ? "已在我的 Skills" : installing ? "正在安装" : action?.phase === "failed" ? "重试安装" : "安装到我的账号"}
            </button>
          </div></footer>
          {action?.phase === "failed" && <small className="product-skill-action-error" role="alert">{action.message}</small>}
          {copyError?.name === skill.name && <small className="product-skill-action-error" role="alert">{copyError.message}</small>}
        </article>;
      })}</div>}
  </section>;
}

function SkillMarketLoading() {
  return <section aria-label="正在读取 Skill 市场" className="product-skill-market product-skill-market-loading" id="skill-market">
    <header><span /><strong /></header><div><span /><span /><span /><span /></div>
  </section>;
}

function SkillMarketError({ message, retry }: { message: string; retry: () => void }) {
  return <section className="product-skill-market product-skill-market-error" id="skill-market"><AlertCircle size={18} /><div><strong>Skill 市场暂时无法读取</strong><p>{message}</p></div><button onClick={retry} type="button">重试</button></section>;
}

async function waitForInstallJob(initial: SkillInstallJob, active: () => boolean): Promise<SkillInstallJob> {
  let job = initial;
  while (!terminalJobStates.has(job.state) && active()) {
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    if (!active()) return job;
    job = await controlApi.skillJob(job.jobId);
  }
  return job;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("浏览器未允许复制，请手动复制资源地址");
}
