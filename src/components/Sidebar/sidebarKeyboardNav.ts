/** Attribute on the focusable part of every sidebar source row. */
export const SIDEBAR_NAV_ITEM_ATTR = 'data-sidebar-nav-item';

const NAV_ITEM_SELECTOR = `[${SIDEBAR_NAV_ITEM_ATTR}]`;

/** Rows a keyboard user can reach: folded sections keep their rows mounted but hidden. */
export function listSidebarNavItems(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(NAV_ITEM_SELECTOR)).filter(
    (item) => item.closest('.sidebar-section-body:not(.is-expanded)') === null,
  );
}

/** j / k move like Down / Up (vim), only as plain presses. */
export function sidebarVimStep(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): 1 | -1 | 0 {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return 0;
  if (event.key === 'j') return 1;
  if (event.key === 'k') return -1;
  return 0;
}

/**
 * Move keyboard focus from the article list to the sidebar (← in the list):
 * the selected source, else the row that holds the sidebar's Tab stop, else
 * the first reachable row. Returns false when the sidebar has no reachable
 * row (hidden, or every section folded), so the key is left alone.
 */
export function focusSidebarSelection(root: ParentNode = document): boolean {
  const nav = root.querySelector<HTMLElement>('[data-component="sidebar-nav"]');
  if (!nav) return false;
  const items = listSidebarNavItems(nav);
  const target = items.find((item) => item.getAttribute('aria-current') === 'page')
    ?? items.find((item) => item.tabIndex === 0)
    ?? items[0];
  if (!target) return false;
  target.focus();
  return true;
}

/**
 * Source list keys (one Tab stop, arrows move between rows, like a macOS
 * source list): Up/Down (or j/k), Home/End move focus; Enter/Space select the
 * row. Returns true when the key was handled.
 */
export function handleSidebarNavKeyDown(
  event: Pick<KeyboardEvent, 'key' | 'target' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'preventDefault'>,
  container: ParentNode,
): boolean {
  const vimStep = sidebarVimStep(event);
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches(NAV_ITEM_SELECTOR)) return false;

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    target.click();
    return true;
  }

  const items = listSidebarNavItems(container);
  const index = items.indexOf(target);
  if (index === -1) return false;

  let next: HTMLElement | undefined;
  if (event.key === 'ArrowDown' || vimStep === 1) next = items[index + 1];
  else if (event.key === 'ArrowUp' || vimStep === -1) next = items[index - 1];
  else if (event.key === 'Home') next = items[0];
  else if (event.key === 'End') next = items[items.length - 1];
  else return false;

  event.preventDefault();
  next?.focus();
  return true;
}

/** Spoken name of a source row: "Unread, 12 unread". */
export function sidebarRowLabel(title: string, unreadCount?: number | null): string {
  return unreadCount && unreadCount > 0 ? `${title}, ${unreadCount} unread` : title;
}
