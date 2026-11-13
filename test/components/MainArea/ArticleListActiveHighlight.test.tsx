import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

let mockReducedMotion = false;

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: () => mockReducedMotion };
});

import { ArticleListActiveHighlight } from '@/components/MainArea/ArticleListActiveHighlight';

const block = (container: HTMLElement) =>
  container.querySelector('[data-section="article-list-active-highlight"]') as HTMLElement;

describe('ArticleListActiveHighlight', () => {
  beforeEach(() => {
    mockReducedMotion = false;
  });

  it('sits at the highlighted row without animating in from elsewhere', () => {
    const { container } = render(
      <ArticleListActiveHighlight hash="a" sourceKey="feed:1" rect={{ top: 300, height: 98 }} />,
    );
    expect(block(container).style.transform).toContain('translateY(300px)');
    expect(block(container).style.height).toBe('98px');
    expect(block(container).dataset.glide).toBe('false');
    expect(block(container).getAttribute('aria-hidden')).toBe('true');
  });

  it('glides to the next row, and snaps when the same row only moves', () => {
    const { container, rerender } = render(
      <ArticleListActiveHighlight hash="a" sourceKey="feed:1" rect={{ top: 0, height: 98 }} />,
    );
    rerender(<ArticleListActiveHighlight hash="b" sourceKey="feed:1" rect={{ top: 100, height: 78 }} />);
    expect(block(container).dataset.glide).toBe('true');

    rerender(<ArticleListActiveHighlight hash="b" sourceKey="feed:1" rect={{ top: 400, height: 78 }} />);
    expect(block(container).dataset.glide).toBe('false');
  });

  it('snaps when the source changes or Reduce Motion is on', () => {
    const { container, rerender } = render(
      <ArticleListActiveHighlight hash="a" sourceKey="feed:1" rect={{ top: 0, height: 98 }} />,
    );
    rerender(<ArticleListActiveHighlight hash="b" sourceKey="feed:2" rect={{ top: 100, height: 98 }} />);
    expect(block(container).dataset.glide).toBe('false');

    mockReducedMotion = true;
    rerender(<ArticleListActiveHighlight hash="c" sourceKey="feed:2" rect={{ top: 200, height: 98 }} />);
    expect(block(container).dataset.glide).toBe('false');
  });

  it('fades out when no row is highlighted', () => {
    const { container } = render(
      <ArticleListActiveHighlight hash={null} sourceKey="feed:1" rect={null} />,
    );
    expect(block(container).style.opacity).toBe('0');
  });
});
