import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { useRef, type RefObject } from 'react';
import type { Article } from '@/types/article';
import { useArticleListKeyboardNavigation } from '@/components/MainArea/hooks/useArticleListKeyboardNavigation';
import { ArticleListItem } from '@/components/MainArea/ArticleListItem';
import { SHORTCUT_GROUPS } from '@/components/SettingsWindow/panes/ShortcutsPane';
import { SHORTCUT_LABELS } from '@/services/shortcuts/shortcutService';

const makeArticles = (count: number): Article[] =>
  Array.from({ length: count }, (_, index) => ({ hash: `a${index}`, title: `Article ${index}` }) as unknown as Article);

const pressOn = (target: EventTarget, key: string, init: KeyboardEventInit & { keyCode?: number } = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  }
  act(() => {
    target.dispatchEvent(event);
  });
};

describe('useArticleListKeyboardNavigation: Enter opens the focused article', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  const setup = (keyboardFocusHash: string | null = 'a2') => {
    const articleListRef = { current: document.createElement('div') } as RefObject<HTMLDivElement>;
    document.body.appendChild(articleListRef.current!);
    const selectArticle = vi.fn();
    const setKeyboardFocusHash = vi.fn();
    renderHook(() => useArticleListKeyboardNavigation({
      articleListRef,
      filteredArticles: makeArticles(5),
      keyboardFocusHash,
      activeArticleHash: null,
      articleViewOverlayPhase: 'closed',
      selectArticle,
      setKeyboardFocusHash,
      scrollKeyboardFocusIntoView: vi.fn(),
    }));
    return { selectArticle, setKeyboardFocusHash };
  };

  it('opens the focused item on Enter, like the Right arrow', () => {
    const { selectArticle } = setup('a2');
    pressOn(document.body, 'Enter');
    expect(selectArticle).toHaveBeenCalledTimes(1);
    expect(selectArticle).toHaveBeenCalledWith('a2');

    pressOn(document.body, 'ArrowRight');
    expect(selectArticle).toHaveBeenCalledTimes(2);
    expect(selectArticle).toHaveBeenLastCalledWith('a2');
  });

  it('focuses the first item on Enter when nothing is focused yet, like the Right arrow', () => {
    const { selectArticle, setKeyboardFocusHash } = setup(null);
    pressOn(document.body, 'Enter');
    expect(selectArticle).not.toHaveBeenCalled();
    expect(setKeyboardFocusHash).toHaveBeenCalledWith('a0');
  });

  it('ignores Enter while an input method is still composing', () => {
    const { selectArticle } = setup('a2');
    pressOn(document.body, 'Enter', { isComposing: true });
    pressOn(document.body, 'Enter', { keyCode: 229 });
    expect(selectArticle).not.toHaveBeenCalled();
  });

  it('ignores Enter typed into an input, textarea or editable text', () => {
    const { selectArticle } = setup('a2');
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not compute isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    document.body.append(input, textarea, editable);

    pressOn(input, 'Enter');
    pressOn(textarea, 'Enter');
    pressOn(editable, 'Enter');
    expect(selectArticle).not.toHaveBeenCalled();
  });

  it('leaves Enter to a focused button and ignores Enter with a modifier', () => {
    const { selectArticle } = setup('a2');
    const button = document.createElement('button');
    document.body.appendChild(button);
    pressOn(button, 'Enter');
    pressOn(document.body, 'Enter', { metaKey: true });
    pressOn(document.body, 'Enter', { shiftKey: true });
    expect(selectArticle).not.toHaveBeenCalled();
  });

  it('opens a DOM-focused row only once when Enter reaches both the row and the list', () => {
    const articles = makeArticles(3);
    const onSelect = vi.fn();

    const Harness = () => {
      const listRef = useRef<HTMLDivElement>(null);
      useArticleListKeyboardNavigation({
        articleListRef: listRef,
        filteredArticles: articles,
        keyboardFocusHash: 'a1',
        activeArticleHash: null,
        articleViewOverlayPhase: 'closed',
        selectArticle: onSelect,
        setKeyboardFocusHash: vi.fn(),
        scrollKeyboardFocusIntoView: vi.fn(),
      });
      return (
        <div ref={listRef}>
          {articles.map((article) => (
            <ArticleListItem
              key={article.hash}
              article={article}
              isActive={false}
              isNew={false}
              newAnimationOrder={-1}
              enableLayoutAnimation={false}
              isTabStop={article.hash === 'a1'}
              onSelect={onSelect}
              formatDateDisplay={() => ''}
            />
          ))}
        </div>
      );
    };

    const { container } = render(<Harness />);
    const row = container.querySelector<HTMLElement>('[data-entity-id="a1"]');
    expect(row).not.toBeNull();
    row!.focus();
    pressOn(row!, 'Enter');

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('a1');
  });

  it('lists Enter for opening an article in Settings → Shortcuts', () => {
    const article = SHORTCUT_GROUPS.find((group) => group.id === 'article');
    const openArticle = article?.items.find((item) => item.id === 'open-article');
    expect(openArticle?.keys).toBe(SHORTCUT_LABELS.OPEN_ARTICLE);
    expect(openArticle?.keys).toContain('Enter');
  });
});
