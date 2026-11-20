import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  ARTICLE_LIST_ACTIVE_HIGHLIGHT_GLIDE,
  ARTICLE_LIST_ACTIVE_HIGHLIGHT_SNAP,
  shouldGlideArticleListActiveHighlight,
} from '@/components/MainArea/articleListActiveHighlightMotion';
import {
  SIDEBAR_GLIDE_TARGET_ATTR,
  measureSidebarGlideBox,
  resolveSidebarGlideItem,
  sameSidebarGlideBox,
  sidebarGlideKey,
  sidebarRowOf,
  type SidebarGlideBox,
} from './sidebarGlideGeometry';

interface SidebarGlideState {
  key: string | null;
  box: SidebarGlideBox | null;
}

const SIDEBAR_GLIDE_SOURCE = 'sidebar';

/**
 * The article list's gliding block (R-07), for the sidebar (R-08). Sidebar rows
 * sit in normal flow across two containers (Library, and the stations
 * scroller), so the block is measured from the DOM instead of from a
 * virtualizer: it re-measures on focus moves, selection changes, scrolling,
 * folding sections and resizes, at most once per frame.
 */
export const SidebarGlideHighlight = memo(function SidebarGlideHighlight({
  navRef,
}: {
  navRef: RefObject<HTMLElement>;
}) {
  const prefersReducedMotion = useReducedMotion() ?? false;
  const [state, setState] = useState<SidebarGlideState>({ key: null, box: null });

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    let frame: number | null = null;
    let targetRow: HTMLElement | null = null;

    const measure = () => {
      frame = null;
      const item = resolveSidebarGlideItem(nav, document.activeElement);
      const row = item ? sidebarRowOf(item) : null;
      if (row !== targetRow) {
        targetRow?.removeAttribute(SIDEBAR_GLIDE_TARGET_ATTR);
        row?.setAttribute(SIDEBAR_GLIDE_TARGET_ATTR, '');
        targetRow = row;
      }
      const box = row ? measureSidebarGlideBox(nav, row) : null;
      const key = row && box ? sidebarGlideKey(row) : null;
      setState((previous) => (
        previous.key === key && sameSidebarGlideBox(previous.box, box) ? previous : { key, box }
      ));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };

    schedule();
    nav.addEventListener('focusin', schedule);
    nav.addEventListener('focusout', schedule);
    // Scroll does not bubble; capture catches the stations scroller.
    nav.addEventListener('scroll', schedule, true);
    nav.addEventListener('transitionend', schedule);

    // Selection, folding and rows coming and going. The target attribute
    // itself is not observed, so setting it never loops.
    const mutations = new MutationObserver(schedule);
    mutations.observe(nav, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-current', 'aria-expanded', 'class'],
    });

    // Sections animate their height when they fold; follow them frame by frame.
    const resizes = new ResizeObserver(schedule);
    resizes.observe(nav);
    nav.querySelectorAll('.sidebar-section-body-clip, .sidebar-scroll-region, .sidebar-nav-body')
      .forEach((element) => resizes.observe(element));

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      nav.removeEventListener('focusin', schedule);
      nav.removeEventListener('focusout', schedule);
      nav.removeEventListener('scroll', schedule, true);
      nav.removeEventListener('transitionend', schedule);
      mutations.disconnect();
      resizes.disconnect();
      targetRow?.removeAttribute(SIDEBAR_GLIDE_TARGET_ATTR);
    };
  }, [navRef]);

  const visible = state.key !== null && state.box !== null;
  const previousRef = useRef({ key: null as string | null, visible: false });
  const glide = shouldGlideArticleListActiveHighlight({
    previousHash: previousRef.current.key,
    nextHash: visible ? state.key : null,
    previousSourceKey: SIDEBAR_GLIDE_SOURCE,
    nextSourceKey: SIDEBAR_GLIDE_SOURCE,
    wasVisible: previousRef.current.visible,
    prefersReducedMotion,
  });
  useLayoutEffect(() => {
    previousRef.current = { key: visible ? state.key : null, visible };
  }, [state.key, visible]);

  const rect = state.box?.rect;
  const clipped = !!state.box && (state.box.clipTop > 0 || state.box.clipBottom > 0);
  const move = glide ? ARTICLE_LIST_ACTIVE_HIGHLIGHT_GLIDE : ARTICLE_LIST_ACTIVE_HIGHLIGHT_SNAP;

  return (
    <motion.div
      className="sidebar-glide-highlight"
      data-section="sidebar-glide-highlight"
      data-glide={glide ? 'true' : 'false'}
      aria-hidden="true"
      initial={false}
      style={{
        clipPath: clipped ? `inset(${state.box!.clipTop}px 0 ${state.box!.clipBottom}px 0)` : undefined,
      }}
      animate={{
        x: rect?.left ?? 0,
        y: rect?.top ?? 0,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        opacity: visible ? 1 : 0,
      }}
      transition={{
        x: move,
        y: move,
        width: move,
        height: move,
        opacity: prefersReducedMotion ? ARTICLE_LIST_ACTIVE_HIGHLIGHT_SNAP : { duration: 0.16, ease: 'easeOut' },
      }}
    />
  );
});
