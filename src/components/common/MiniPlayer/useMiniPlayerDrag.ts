import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';

import { useDependencyEffect, useUnmountEffect } from '@/hooks/useLifecycleEffects';

/** Distance from the window's right and bottom edges, in CSS pixels. */
export interface MiniPlayerOffset {
  right: number;
  bottom: number;
}

interface Size {
  width: number;
  height: number;
}

export const MINI_PLAYER_STORAGE_KEY = 'mini-player-offset';
export const DEFAULT_MINI_PLAYER_OFFSET: MiniPlayerOffset = { right: 14, bottom: 14 };
/** Matches `.mini-player-pill` height in MiniPlayer.css. */
export const MINI_PLAYER_PILL_HEIGHT = 48;
/** Match `.mini-player` widths in MiniPlayer.css: collapsed, and spread open on hover. */
export const MINI_PLAYER_COMPACT_WIDTH = 248;
export const MINI_PLAYER_EXPANDED_WIDTH = 400;
const WINDOW_GUTTER = 28;
const EDGE_MARGIN = 8;
const QUEUE_GAP = 8;
const QUEUE_MAX_HEIGHT = 320;
/** Movement below this is a click, not a drag. */
const DRAG_THRESHOLD = 4;

/** Keep the whole pill inside the window. */
export function clampMiniPlayerOffset(offset: MiniPlayerOffset, size: Size, viewport: Size): MiniPlayerOffset {
  const maxRight = Math.max(EDGE_MARGIN, viewport.width - size.width - EDGE_MARGIN);
  const maxBottom = Math.max(EDGE_MARGIN, viewport.height - size.height - EDGE_MARGIN);
  return {
    right: Math.round(Math.min(maxRight, Math.max(EDGE_MARGIN, offset.right))),
    bottom: Math.round(Math.min(maxBottom, Math.max(EDGE_MARGIN, offset.bottom))),
  };
}

export function miniPlayerWidth(viewportWidth: number, expanded: boolean): number {
  return Math.min(expanded ? MINI_PLAYER_EXPANDED_WIDTH : MINI_PLAYER_COMPACT_WIDTH, viewportWidth - WINDOW_GUTTER);
}

/**
 * Where the pill is drawn. The saved spot is for the collapsed pill and keeps
 * its right edge; spread open near the left edge it grows rightwards instead,
 * so its left edge stays put and nothing leaves the window.
 */
export function displayedMiniPlayerOffset(offset: MiniPlayerOffset, expanded: boolean, viewportWidth: number): MiniPlayerOffset {
  if (!expanded) return offset;
  const maxRight = Math.max(EDGE_MARGIN, viewportWidth - miniPlayerWidth(viewportWidth, true) - EDGE_MARGIN);
  return { right: Math.min(offset.right, maxRight), bottom: offset.bottom };
}

/** The queue opens on whichever side of the pill has more room. */
export function miniPlayerQueueLayout(bottom: number, viewportHeight: number): { placement: 'above' | 'below'; maxHeight: number } {
  const spaceAbove = viewportHeight - bottom - MINI_PLAYER_PILL_HEIGHT - QUEUE_GAP - EDGE_MARGIN;
  const spaceBelow = bottom - QUEUE_GAP - EDGE_MARGIN;
  const placement = spaceAbove >= spaceBelow ? 'above' : 'below';
  return { placement, maxHeight: Math.max(0, Math.min(QUEUE_MAX_HEIGHT, placement === 'above' ? spaceAbove : spaceBelow)) };
}

function readStoredOffset(): MiniPlayerOffset {
  try {
    const parsed = JSON.parse(localStorage.getItem(MINI_PLAYER_STORAGE_KEY) ?? 'null') as Partial<MiniPlayerOffset> | null;
    if (parsed && Number.isFinite(parsed.right) && Number.isFinite(parsed.bottom)) {
      return { right: parsed.right!, bottom: parsed.bottom! };
    }
  } catch {
    // Blocked or corrupt storage: fall back to the corner.
  }
  return DEFAULT_MINI_PLAYER_OFFSET;
}

function storeOffset(offset: MiniPlayerOffset): void {
  try {
    localStorage.setItem(MINI_PLAYER_STORAGE_KEY, JSON.stringify(offset));
  } catch {
    // Position is a convenience; losing it is fine.
  }
}

function viewportSize(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  origin: MiniPlayerOffset;
  last: MiniPlayerOffset;
  moved: boolean;
}

/**
 * Lets the user drag the mini player anywhere in the window by grabbing any
 * part of the pill. A press that does not move still clicks the control under
 * it; a real drag swallows the click that follows. The spot is remembered.
 * `wantsExpanded` is whether the pill is spread open; it also stays open for
 * the whole drag, even when the pointer runs past it at the window edge.
 */
export function useMiniPlayerDrag(wantsExpanded: boolean) {
  const [offset, setOffset] = useState<MiniPlayerOffset>(readStoredOffset);
  const [viewport, setViewport] = useState<Size>(viewportSize);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const detachRef = useRef<(() => void) | null>(null);
  const expanded = wantsExpanded || dragging;

  // The saved spot is the collapsed pill's; the open pill is fitted when drawn.
  const clamp = useCallback((next: MiniPlayerOffset, size: Size = viewportSize()) => (
    clampMiniPlayerOffset(next, { width: miniPlayerWidth(size.width, false), height: MINI_PLAYER_PILL_HEIGHT }, size)
  ), []);

  useDependencyEffect(() => {
    const onResize = () => {
      const size = viewportSize();
      setViewport(size);
      setOffset((current) => clamp(current, size));
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  useUnmountEffect(() => detachRef.current?.());

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    // Start from where the pill is drawn, so a pill shifted to fit while open
    // follows the pointer at once.
    const origin = displayedMiniPlayerOffset(offset, expanded, viewport.width);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      last: origin,
      moved: false,
    };

    const onMove = (move: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || move.pointerId !== drag.pointerId) return;
      const dx = move.clientX - drag.startX;
      const dy = move.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!drag.moved) {
        drag.moved = true;
        setDragging(true);
      }
      move.preventDefault();
      drag.last = clamp({ right: drag.origin.right - dx, bottom: drag.origin.bottom - dy });
      setOffset(drag.last);
    };

    const onEnd = (end: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || end.pointerId !== drag.pointerId) return;
      detach();
      if (!drag.moved) return;
      setDragging(false);
      storeOffset(drag.last);
      // The click that ends a drag lands on whatever button is under the
      // pointer; swallow it, but never a later, real click.
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };

    const detach = () => {
      dragRef.current = null;
      detachRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };

    detachRef.current = detach;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }, [clamp, expanded, offset, viewport.width]);

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    offset,
    position: displayedMiniPlayerOffset(offset, expanded, viewport.width),
    expanded,
    dragging,
    queueLayout: miniPlayerQueueLayout(offset.bottom, viewport.height),
    onPointerDown,
    onClickCapture,
  };
}
