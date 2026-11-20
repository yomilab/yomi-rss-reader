import { afterEach, describe, expect, it } from 'vitest';
import {
  computeSidebarGlideBox,
  resolveSidebarGlideItem,
  sameSidebarGlideBox,
  sidebarGlideKey,
  sidebarRowOf,
} from '@/components/Sidebar/sidebarGlideGeometry';

const rect = (top: number, height: number, left = 10, width = 200) => ({
  top, bottom: top + height, left, width, height,
});
const nav = { ...rect(100, 500, 0, 240), scrollTop: 0, scrollLeft: 0 };

describe('computeSidebarGlideBox', () => {
  it('places the row in the nav coordinates', () => {
    expect(computeSidebarGlideBox(rect(150, 30), nav, [])).toEqual({
      rect: { top: 50, left: 10, width: 200, height: 30 },
      clipTop: 0,
      clipBottom: 0,
    });
  });

  it('adds the nav scroll offset', () => {
    expect(computeSidebarGlideBox(rect(150, 30), { ...nav, scrollTop: 20 }, [])?.rect.top).toBe(70);
  });

  it('clips the part of a row the stations scroller hides', () => {
    const box = computeSidebarGlideBox(rect(290, 30), nav, [rect(300, 200)]);
    expect(box?.clipTop).toBe(10);
    expect(box?.clipBottom).toBe(0);
    expect(box?.rect.height).toBe(30);
  });

  it('hides the block for rows scrolled or folded out of view, and for empty rows', () => {
    expect(computeSidebarGlideBox(rect(250, 30), nav, [rect(300, 200)])).toBeNull();
    expect(computeSidebarGlideBox(rect(150, 30), nav, [rect(150, 0)])).toBeNull();
    expect(computeSidebarGlideBox(rect(150, 0), nav, [])).toBeNull();
  });
});

describe('sidebar glide target', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const build = () => {
    document.body.innerHTML = `
      <nav>
        <div class="sidebar-section-body is-expanded">
          <li class="smart-view-item" data-section="smart-view-item" data-entity-id="today">
            <div data-sidebar-nav-item="" tabindex="-1" id="today"></div>
          </li>
          <div class="tag-item" data-section="station-item" data-entity-id="Tech" data-station-name="Tech">
            <div data-sidebar-nav-item="" tabindex="0" aria-current="page" id="tech"></div>
          </div>
          <div data-station-name="Tech">
            <div class="station-feed-item" data-section="station-feed-item" data-entity-id="f1">
              <div data-sidebar-nav-item="" tabindex="-1" id="f1"></div>
            </div>
          </div>
        </div>
        <div class="sidebar-section-body">
          <div data-section="unstationed-feed-item" data-entity-id="f2">
            <div data-sidebar-nav-item="" tabindex="-1" id="hidden"></div>
          </div>
        </div>
      </nav>`;
    return document.querySelector('nav')!;
  };
  const byId = (id: string) => document.getElementById(id)!;

  it('follows the focused row, else the selected source', () => {
    const navElement = build();
    expect(resolveSidebarGlideItem(navElement, byId('today'))).toBe(byId('today'));
    expect(resolveSidebarGlideItem(navElement, document.body)).toBe(byId('tech'));
    // Rows in folded sections never take the block.
    expect(resolveSidebarGlideItem(navElement, byId('hidden'))).toBe(byId('tech'));
  });

  it('keys rows by section, station and source', () => {
    build();
    expect(sidebarGlideKey(sidebarRowOf(byId('today')))).toBe('smart-view-item::today');
    expect(sidebarGlideKey(sidebarRowOf(byId('f1')))).toBe('station-feed-item:Tech:f1');
  });

  it('compares boxes to the half pixel', () => {
    const a = computeSidebarGlideBox(rect(150, 30), nav, []);
    const b = computeSidebarGlideBox(rect(150.2, 30), nav, []);
    const c = computeSidebarGlideBox(rect(152, 30), nav, []);
    expect(sameSidebarGlideBox(a, b)).toBe(true);
    expect(sameSidebarGlideBox(a, c)).toBe(false);
    expect(sameSidebarGlideBox(a, null)).toBe(false);
  });
});
