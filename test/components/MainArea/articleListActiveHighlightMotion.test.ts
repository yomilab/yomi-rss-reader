import { describe, expect, it } from 'vitest';
import {
  ARTICLE_LIST_ACTIVE_HIGHLIGHT_GLIDE,
  ARTICLE_LIST_ROW_GAP_PX,
  resolveArticleListActiveHighlightRect,
  shouldGlideArticleListActiveHighlight,
} from '@/components/MainArea/articleListActiveHighlightMotion';

describe('resolveArticleListActiveHighlightRect', () => {
  const measurements = [
    { index: 0, start: 0, size: 102 },
    { index: 1, start: 102, size: 82 },
    { index: 2, start: 184, size: 142 },
  ];

  it('covers the row minus the gap under it', () => {
    expect(resolveArticleListActiveHighlightRect(1, measurements, [])).toEqual({
      top: 102,
      height: 82 - ARTICLE_LIST_ROW_GAP_PX,
    });
  });

  it('uses the measurement for a row that is not mounted', () => {
    expect(resolveArticleListActiveHighlightRect(2, measurements, [measurements[0]])).toEqual({
      top: 184,
      height: 140,
    });
  });

  it('falls back to a mounted row when there is no measurement', () => {
    expect(resolveArticleListActiveHighlightRect(5, undefined, [{ index: 5, start: 500, size: 90 }])).toEqual({
      top: 500,
      height: 88,
    });
  });

  it('hides the block when no row is highlighted or the row is unknown', () => {
    expect(resolveArticleListActiveHighlightRect(-1, measurements, [])).toBeNull();
    expect(resolveArticleListActiveHighlightRect(9, measurements, [])).toBeNull();
    expect(resolveArticleListActiveHighlightRect(0, [{ index: 0, start: Number.NaN, size: 10 }], [])).toBeNull();
  });
});

describe('shouldGlideArticleListActiveHighlight', () => {
  const move = {
    previousHash: 'a',
    nextHash: 'b',
    previousSourceKey: 'feed:1',
    nextSourceKey: 'feed:1',
    wasVisible: true,
    prefersReducedMotion: false,
  };

  it('glides when the user moves to another row in the same list', () => {
    expect(shouldGlideArticleListActiveHighlight(move)).toBe(true);
  });

  it('snaps when the same row only changes place', () => {
    expect(shouldGlideArticleListActiveHighlight({ ...move, nextHash: 'a' })).toBe(false);
  });

  it('snaps on the first highlight and after the block was hidden', () => {
    expect(shouldGlideArticleListActiveHighlight({ ...move, previousHash: null })).toBe(false);
    expect(shouldGlideArticleListActiveHighlight({ ...move, wasVisible: false })).toBe(false);
  });

  it('snaps when the list changes to another source', () => {
    expect(shouldGlideArticleListActiveHighlight({ ...move, nextSourceKey: 'feed:2' })).toBe(false);
  });

  it('snaps with Reduce Motion on', () => {
    expect(shouldGlideArticleListActiveHighlight({ ...move, prefersReducedMotion: true })).toBe(false);
  });

  it('glides on a curve that settles without overshooting', () => {
    expect(ARTICLE_LIST_ACTIVE_HIGHLIGHT_GLIDE).toMatchObject({ type: 'spring', bounce: 0 });
    expect(ARTICLE_LIST_ACTIVE_HIGHLIGHT_GLIDE.visualDuration).toBeGreaterThan(0.15);
    expect(ARTICLE_LIST_ACTIVE_HIGHLIGHT_GLIDE.visualDuration).toBeLessThan(0.5);
  });
});
