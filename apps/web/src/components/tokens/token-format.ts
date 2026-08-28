const exact = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

/** 执行「formatTokenCount」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function formatTokenCount(value: number): string {
  return exact.format(value);
}

/** 执行「formatContextWindow」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function formatContextWindow(value: number | undefined): string | undefined {
  if (value === undefined || !validTokenCapacity(value)) return undefined;
  return `上下文窗口 ${formatTokenCount(value)} tokens`;
}

/** 执行「joinMetadata」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function joinMetadata(parts: ReadonlyArray<string | undefined>): string {
  return parts.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(part): part is string => typeof part === "string" && part.length > 0).join(" · ");
}

/** 执行「validTokenCapacity」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function validTokenCapacity(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
