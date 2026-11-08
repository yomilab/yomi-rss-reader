/**
 * Where the sidebar's gliding highlight goes (R-08): the same block the article
 * list uses (R-07), behind the row the keyboard is on, else the selected source.
 */
import { listSidebarNavItems } from './sidebarKeyboardNav';

/** Set on the row the block sits behind; the row's text colors follow it. */
export const SIDEBAR_GLIDE_TARGET_ATTR = 'data-sidebar-glide-target';

/** Containers between the nav and a row that clip it (folding sections, the stations scroller). */
const CLIP_CONTAINER_SELECTOR = '.sidebar-section-body-clip, .sidebar-scroll-region';

export interface SidebarGlideRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface SidebarGlideBox {
  /** Row box in the nav's own (scrolled) coordinates. */
  rect: SidebarGlideRect;
  /** How much of the row's top and bottom is hidden by a clipping container. */
  clipTop: number;
  clipBottom: number;
}

interface ViewportRect {
  top: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

/** The visible row element around a focusable nav item (it carries the selected tint today). */
export function sidebarRowOf(item: HTMLElement): HTMLElement {
  return item.parentElement ?? item;
}

/** Stable identity for a row, so a re-render of the same source does not count as a move. */
export function sidebarGlideKey(row: HTMLElement): string {
  const station = row.parentElement?.closest<HTMLElement>('[data-station-name]')?.dataset.stationName ?? '';
  return `${row.dataset.section ?? ''}:${station}:${row.dataset.entityId ?? ''}`;
}

/**
 * The row the block marks: the focused row while the keyboard is in the
 * sidebar, else the selected source. Rows in folded sections don't count.
 */
export function resolveSidebarGlideItem(nav: ParentNode, activeElement: Element | null): HTMLElement | null {
  const items = listSidebarNavItems(nav);
  if (activeElement instanceof HTMLElement && items.includes(activeElement)) return activeElement;
  return items.find((item) => item.getAttribute('aria-current') === 'page') ?? null;
}

/**
 * Pure part of the measurement: place the row in the nav's coordinates and
 * work out how much of it the clipping containers hide. Returns null when the
 * row is empty or fully hidden.
 */
export function computeSidebarGlideBox(
  row: ViewportRect,
  nav: ViewportRect & { scrollTop: number; scrollLeft: number },
  clips: ReadonlyArray<Pick<ViewportRect, 'top' | 'bottom'>>,
): SidebarGlideBox | null {
  if (row.width <= 0 || row.height <= 0) return null;
  let visibleTop = Math.max(row.top, nav.top);
  let visibleBottom = Math.min(row.bottom, nav.bottom);
  for (const clip of clips) {
    visibleTop = Math.max(visibleTop, clip.top);
    visibleBottom = Math.min(visibleBottom, clip.bottom);
  }
  if (visibleBottom - visibleTop < 1) return null;
  return {
    rect: {
      top: row.top - nav.top + nav.scrollTop,
      left: row.left - nav.left + nav.scrollLeft,
      width: row.width,
      height: row.height,
    },
    clipTop: Math.max(0, visibleTop - row.top),
    clipBottom: Math.max(0, row.bottom - visibleBottom),
  };
}

export function measureSidebarGlideBox(nav: HTMLElement, row: HTMLElement): SidebarGlideBox | null {
  const clips: Array<Pick<ViewportRect, 'top' | 'bottom'>> = [];
  for (let el = row.parentElement; el && el !== nav; el = el.parentElement) {
    if (el.matches(CLIP_CONTAINER_SELECTOR)) clips.push(el.getBoundingClientRect());
  }
  const navRect = nav.getBoundingClientRect();
  return computeSidebarGlideBox(
    row.getBoundingClientRect(),
    {
      top: navRect.top,
      bottom: navRect.bottom,
      left: navRect.left,
      width: navRect.width,
      height: navRect.height,
      scrollTop: nav.scrollTop,
      scrollLeft: nav.scrollLeft,
    },
    clips,
  );
}

export function sameSidebarGlideBox(a: SidebarGlideBox | null, b: SidebarGlideBox | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  return near(a.rect.top, b.rect.top)
    && near(a.rect.left, b.rect.left)
    && near(a.rect.width, b.rect.width)
    && near(a.rect.height, b.rect.height)
    && near(a.clipTop, b.clipTop)
    && near(a.clipBottom, b.clipBottom);
}
