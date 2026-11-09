import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

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
 */
export function useMiniPlayerDrag(pillRef: RefObject<HTMLElement | null>) {
  const [offset, setOffset] = useState<MiniPlayerOffset>(readStoredOffset);
  const [viewport, setViewport] = useState<Size>(viewportSize);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const detachRef = useRef<(() => void) | null>(null);

  const clamp = useCallback((next: MiniPlayerOffset, size: Size = viewportSize()) => {
    const rect = pillRef.current?.getBoundingClientRect();
    const pill = {
      width: rect && rect.width > 0 ? rect.width : Math.min(400, size.width - 28),
      height: rect && rect.height > 0 ? rect.height : MINI_PLAYER_PILL_HEIGHT,
    };
    return clampMiniPlayerOffset(next, pill, size);
  }, [pillRef]);

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
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: offset,
      last: offset,
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
  }, [clamp, offset]);

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    offset,
    dragging,
    queueLayout: miniPlayerQueueLayout(offset.bottom, viewport.height),
    onPointerDown,
    onClickCapture,
  };
}
