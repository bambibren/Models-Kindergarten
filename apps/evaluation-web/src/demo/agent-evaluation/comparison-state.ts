/** 执行「scrollTopForVisibleItem」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function scrollTopForVisibleItem(
  scrollTop: number,
  viewportHeight: number,
  itemTop: number,
  itemHeight: number,
): number {
  const visibleBottom = scrollTop + viewportHeight;
  const itemBottom = itemTop + itemHeight;
  if (itemTop < scrollTop) return itemTop;
  if (itemBottom > visibleBottom) return itemBottom - viewportHeight;
  return scrollTop;
}
