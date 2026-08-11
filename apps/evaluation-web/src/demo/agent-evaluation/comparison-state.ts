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
