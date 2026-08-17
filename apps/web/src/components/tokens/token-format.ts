const exact = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

export function formatTokenCount(value: number): string {
  return exact.format(value);
}

export function formatContextWindow(value: number | undefined): string | undefined {
  if (value === undefined || !validTokenCapacity(value)) return undefined;
  return `上下文窗口 ${formatTokenCount(value)} tokens`;
}

export function joinMetadata(parts: ReadonlyArray<string | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
}

function validTokenCapacity(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
