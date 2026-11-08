import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const sidebar = read('src/components/Sidebar/Sidebar.css');
const rowSheets = {
  '.smart-view-item.is-selected': read('src/components/Sidebar/SmartViews.css'),
  '.tag-item.is-selected': read('src/components/Sidebar/TagManager.css'),
  '.station-feed-item-selected': read('src/components/Sidebar/TagManager.css'),
  '.feed-list-item-selected': read('src/components/Sidebar/FeedList.css'),
};

const rule = (css: string, selector: string) => {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`Missing ${selector}`);
  return css.slice(start, css.indexOf('}', start));
};

describe('sidebar gliding highlight styles (R-08)', () => {
  it('gives the block its own stacking context in the nav, under every row', () => {
    expect(rule(sidebar, '.sidebar-content')).toMatch(/position: relative;[\s\S]*isolation: isolate;/);
    const block = rule(sidebar, '.sidebar-glide-highlight');
    expect(block).toContain('z-index: -1');
    expect(block).toContain('pointer-events: none');
  });

  it('uses the same colors as the article list block', () => {
    expect(rule(sidebar, '.sidebar-glide-highlight')).toContain('background-color: var(--article-list-active-bg)');
    expect(rule(sidebar, 'nav.sidebar-content [data-sidebar-glide-target]')).toContain('color: var(--article-list-active-color)');
  });

  it.each(Object.entries(rowSheets))('%s no longer paints its own tint or text color', (selector, css) => {
    const body = rule(css, selector);
    expect(body).not.toContain('background-color');
    expect(body).not.toMatch(/\n\s*color:/);
  });

  it('drops the focus ring on the row the block marks', () => {
    expect(rule(sidebar, 'nav.sidebar-content [data-sidebar-glide-target]:has(:focus-visible)')).toContain('outline: none');
  });
});
