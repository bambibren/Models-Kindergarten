import type { DemoExperimentRecord } from "../demo-types.js";

export const PAGE_SIZE = 10;

/** 执行「filterExperiments」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function filterExperiments(records: DemoExperimentRecord[], search: string): DemoExperimentRecord[] {
  const needle = search.trim().toLocaleLowerCase("zh-CN");
  if (!needle) return records;
  return records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(record) => [record.title, record.prompt, record.model]
    .some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(value) => value.toLocaleLowerCase("zh-CN").includes(needle)));
}

/** 执行「pageExperiments」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function pageExperiments(records: DemoExperimentRecord[], page: number): DemoExperimentRecord[] {
  const safePage = Math.max(1, page);
  return records.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
}

/** 执行「pageCount」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}
