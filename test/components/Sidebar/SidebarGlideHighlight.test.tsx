import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { SidebarGlideHighlight } from '@/components/Sidebar/SidebarGlideHighlight';

const ROW_TOPS: Record<string, number> = { today: 10, unread: 50, tech: 120 };

function Harness() {
  const navRef = useRef<HTMLElement>(null);
  return (
    <nav ref={navRef} data-component="sidebar-nav">
      <SidebarGlideHighlight navRef={navRef} />
      <div className="sidebar-section-body is-expanded">
        <ul>
          <li className="smart-view-item" data-section="smart-view-item" data-entity-id="today">
            <div role="button" tabIndex={-1} data-sidebar-nav-item="" />
          </li>
          <li className="smart-view-item" data-section="smart-view-item" data-entity-id="unread">
            <div role="button" tabIndex={0} aria-current="page" data-sidebar-nav-item="" />
          </li>
          <li className="smart-view-item" data-section="smart-view-item" data-entity-id="tech">
            <div role="button" tabIndex={-1} data-sidebar-nav-item="" />
          </li>
        </ul>
      </div>
    </nav>
  );
}

const block = (container: HTMLElement) =>
  container.querySelector('[data-section="sidebar-glide-highlight"]') as HTMLElement;
const row = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-entity-id="${id}"]`)!;

describe('SidebarGlideHighlight', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const id = this.dataset.entityId;
      const top = id && id in ROW_TOPS ? ROW_TOPS[id] : 0;
      const isRow = !!id;
      const height = isRow ? 32 : 600;
      const width = isRow ? 200 : 240;
      return { top, bottom: top + height, left: isRow ? 8 : 0, right: 0, width, height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('sits behind the selected source and gives it the active text color', async () => {
    const { container } = render(<Harness />);
    await waitFor(() => expect(block(container).style.opacity).toBe('1'));
    expect(block(container).style.transform).toContain('translateY(50px)');
    expect(block(container).style.height).toBe('32px');
    expect(row(container, 'unread').hasAttribute('data-sidebar-glide-target')).toBe(true);
    // First in the nav, under every row.
    expect(container.querySelector('nav')!.firstElementChild).toBe(block(container));
  });

  it('glides to the row the keyboard moves to, and back to the selection when focus leaves', async () => {
    const { container } = render(<Harness />);
    await waitFor(() => expect(block(container).style.opacity).toBe('1'));

    act(() => {
      row(container, 'tech').querySelector<HTMLElement>('[data-sidebar-nav-item]')!.focus();
    });
    await waitFor(() => expect(block(container).style.transform).toContain('translateY(120px)'));
    expect(block(container).dataset.glide).toBe('true');
    expect(row(container, 'tech').hasAttribute('data-sidebar-glide-target')).toBe(true);
    expect(row(container, 'unread').hasAttribute('data-sidebar-glide-target')).toBe(false);

    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    await waitFor(() => expect(row(container, 'unread').hasAttribute('data-sidebar-glide-target')).toBe(true));
  });

  it('clears the row attribute when it unmounts', async () => {
    const { container, unmount } = render(<Harness />);
    await waitFor(() => expect(row(container, 'unread').hasAttribute('data-sidebar-glide-target')).toBe(true));
    const selected = row(container, 'unread');
    unmount();
    expect(selected.hasAttribute('data-sidebar-glide-target')).toBe(false);
  });
});
