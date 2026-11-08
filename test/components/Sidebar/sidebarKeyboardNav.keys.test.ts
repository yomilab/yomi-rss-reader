import { afterEach, describe, expect, it } from 'vitest';
import {
  focusSidebarSelection,
  handleSidebarNavKeyDown,
  sidebarVimStep,
} from '@/components/Sidebar/sidebarKeyboardNav';

/** Library (Today, Unread selected) and a folded section with one feed. */
const buildSidebar = ({ selected = 'unread', libraryFolded = false } = {}) => {
  document.body.innerHTML = `
    <nav data-component="sidebar-nav">
      <div class="sidebar-section-body${libraryFolded ? '' : ' is-expanded'}">
        <div role="button" tabindex="${selected === 'today' ? 0 : -1}" data-sidebar-nav-item="" data-id="today"
          ${selected === 'today' ? 'aria-current="page"' : ''}></div>
        <div role="button" tabindex="${selected === 'unread' ? 0 : -1}" data-sidebar-nav-item="" data-id="unread"
          ${selected === 'unread' ? 'aria-current="page"' : ''}></div>
      </div>
      <div class="sidebar-section-body is-expanded">
        <div role="button" tabindex="${selected === 'feed' ? 0 : -1}" data-sidebar-nav-item="" data-id="feed"
          ${selected === 'feed' ? 'aria-current="page"' : ''}></div>
      </div>
    </nav>`;
  return document.querySelector<HTMLElement>('nav')!;
};

const item = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;

const press = (target: HTMLElement, key: string, init: Partial<KeyboardEvent> = {}) => {
  const event = {
    key,
    target,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...init,
  };
  const handled = handleSidebarNavKeyDown(event, document.querySelector('nav')!);
  return { handled, prevented: event.defaultPrevented };
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('sidebar j / k', () => {
  it('maps plain j / k to down / up and ignores them with a modifier or Shift', () => {
    const base = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(sidebarVimStep({ ...base, key: 'j' })).toBe(1);
    expect(sidebarVimStep({ ...base, key: 'k' })).toBe(-1);
    expect(sidebarVimStep({ ...base, key: 'J', shiftKey: true })).toBe(0);
    expect(sidebarVimStep({ ...base, key: 'j', metaKey: true })).toBe(0);
    expect(sidebarVimStep({ ...base, key: 'x' })).toBe(0);
  });

  it('moves focus between rows like the arrow keys', () => {
    buildSidebar();
    item('today').focus();
    expect(press(item('today'), 'j')).toEqual({ handled: true, prevented: true });
    expect(document.activeElement).toBe(item('unread'));
    press(item('unread'), 'j');
    expect(document.activeElement).toBe(item('feed'));
    press(item('feed'), 'k');
    expect(document.activeElement).toBe(item('unread'));
  });

  it('leaves Shift+J alone', () => {
    buildSidebar();
    item('today').focus();
    expect(press(item('today'), 'J', { shiftKey: true }).handled).toBe(false);
    expect(document.activeElement).toBe(item('today'));
  });
});

describe('focusSidebarSelection (← from the article list)', () => {
  it('focuses the selected source', () => {
    buildSidebar({ selected: 'feed' });
    expect(focusSidebarSelection()).toBe(true);
    expect(document.activeElement).toBe(item('feed'));
  });

  it('falls back to the first reachable row when the selection is folded away', () => {
    buildSidebar({ selected: 'unread', libraryFolded: true });
    expect(focusSidebarSelection()).toBe(true);
    expect(document.activeElement).toBe(item('feed'));
  });

  it('does nothing without a sidebar', () => {
    expect(focusSidebarSelection()).toBe(false);
  });
});
