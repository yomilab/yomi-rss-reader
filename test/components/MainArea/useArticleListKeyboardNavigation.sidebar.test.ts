import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import type { Article } from '@/types/article';
import type { ArticleViewOverlayPhase } from '@/contexts/FeedContext';
import { useArticleListKeyboardNavigation } from '@/components/MainArea/hooks/useArticleListKeyboardNavigation';

const articles = Array.from({ length: 5 }, (_, index) => ({ hash: `a${index}` }) as unknown as Article);

const setup = (phase: ArticleViewOverlayPhase = 'closed') => {
  document.body.innerHTML = `
    <nav data-component="sidebar-nav">
      <div class="sidebar-section-body is-expanded">
        <div role="button" tabindex="-1" data-sidebar-nav-item="" data-id="today"></div>
        <div role="button" tabindex="0" data-sidebar-nav-item="" data-id="feed" aria-current="page"></div>
      </div>
    </nav>
    <div id="list"></div>`;
  const articleListRef = { current: document.getElementById('list') } as RefObject<HTMLDivElement>;
  const setKeyboardFocusHash = vi.fn();
  renderHook(() => useArticleListKeyboardNavigation({
    articleListRef,
    filteredArticles: articles,
    keyboardFocusHash: null,
    activeArticleHash: 'a1',
    articleViewOverlayPhase: phase,
    selectArticle: vi.fn(),
    setKeyboardFocusHash,
    scrollKeyboardFocusIntoView: vi.fn(),
  }));
  return { setKeyboardFocusHash };
};

const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

const sidebarItem = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('article list ← to the sidebar (R-08)', () => {
  it('moves focus to the selected source', () => {
    const { setKeyboardFocusHash } = setup();
    const event = press(document.body, 'ArrowLeft');
    expect(document.activeElement).toBe(sidebarItem('feed'));
    expect(event.defaultPrevented).toBe(true);
    expect(setKeyboardFocusHash).not.toHaveBeenCalled();
  });

  it('moves to the sidebar with h too', () => {
    setup();
    press(document.body, 'h');
    expect(document.activeElement).toBe(sidebarItem('feed'));
  });

  it('leaves h / l pressed in the sidebar to the sidebar', () => {
    const { setKeyboardFocusHash } = setup();
    sidebarItem('today').focus();
    expect(press(sidebarItem('today'), 'h').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(sidebarItem('today'));
    expect(setKeyboardFocusHash).not.toHaveBeenCalled();
  });

  it('leaves ← alone with a modifier or while the article covers the list', () => {
    setup();
    expect(press(document.body, 'ArrowLeft', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);

    cleanup();
    setup('open');
    expect(press(document.body, 'ArrowLeft').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('does not step the article list when j / k are pressed in the sidebar', () => {
    const { setKeyboardFocusHash } = setup();
    sidebarItem('today').focus();
    press(sidebarItem('today'), 'j');
    press(sidebarItem('today'), 'k');
    expect(setKeyboardFocusHash).not.toHaveBeenCalled();
  });

  it('still steps the list with j outside the sidebar', () => {
    const { setKeyboardFocusHash } = setup();
    press(document.body, 'j');
    expect(setKeyboardFocusHash).toHaveBeenCalledWith('a2');
  });
});
