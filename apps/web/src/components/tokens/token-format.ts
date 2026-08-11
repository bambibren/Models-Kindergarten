const exact = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

export function formatTokenCount(value: number): string {
  return exact.format(value);
}
