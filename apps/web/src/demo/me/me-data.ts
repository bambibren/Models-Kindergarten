import type { DemoExperimentRecord } from "../demo-types.js";

export const PAGE_SIZE = 10;

export function filterExperiments(records: DemoExperimentRecord[], search: string): DemoExperimentRecord[] {
  const needle = search.trim().toLocaleLowerCase("zh-CN");
  if (!needle) return records;
  return records.filter((record) => [record.title, record.prompt, record.model]
    .some((value) => value.toLocaleLowerCase("zh-CN").includes(needle)));
}

export function pageExperiments(records: DemoExperimentRecord[], page: number): DemoExperimentRecord[] {
  const safePage = Math.max(1, page);
  return records.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}
