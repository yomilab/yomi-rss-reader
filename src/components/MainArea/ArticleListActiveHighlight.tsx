import { memo, useLayoutEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  ARTICLE_LIST_ACTIVE_HIGHLIGHT_GLIDE,
  ARTICLE_LIST_ACTIVE_HIGHLIGHT_SNAP,
  shouldGlideArticleListActiveHighlight,
  type ArticleListActiveHighlightRect,
} from './articleListActiveHighlightMotion';

interface ArticleListActiveHighlightProps {
  /** The highlighted row's hash, or null when no row is highlighted. */
  hash: string | null;
  sourceKey: string;
  rect: ArticleListActiveHighlightRect | null;
}

/**
 * The block behind the active row. It lives in the virtual spacer, before the
 * rows, so it scrolls with the list and paints under the row text.
 */
export const ArticleListActiveHighlight = memo(function ArticleListActiveHighlight({
  hash,
  sourceKey,
  rect,
}: ArticleListActiveHighlightProps) {
  const prefersReducedMotion = useReducedMotion() ?? false;
  const visible = hash !== null && rect !== null;
  const previousRef = useRef({ hash: null as string | null, sourceKey, visible: false });
  const previous = previousRef.current;

  const glide = shouldGlideArticleListActiveHighlight({
    previousHash: previous.hash,
    nextHash: visible ? hash : null,
    previousSourceKey: previous.sourceKey,
    nextSourceKey: sourceKey,
    wasVisible: previous.visible,
    prefersReducedMotion,
  });
  // Remember what was committed, not what was rendered: a render can run twice
  // (StrictMode) and must reach the same decision both times.
  useLayoutEffect(() => {
    previousRef.current = { hash: visible ? hash : null, sourceKey, visible };
  }, [hash, sourceKey, visible]);

  // While hidden, stay where the last row was; the next highlight snaps in.
  const top = rect?.top ?? 0;
  const height = rect?.height ?? 0;

  return (
    <motion.div
      className="article-list-active-highlight"
      data-section="article-list-active-highlight"
      data-glide={glide ? 'true' : 'false'}
      aria-hidden="true"
      initial={false}
      animate={{ y: top, height, opacity: visible ? 1 : 0 }}
      transition={{
        y: glide ? ARTICLE_LIST_ACTIVE_HIGHLIGHT_GLIDE : ARTICLE_LIST_ACTIVE_HIGHLIGHT_SNAP,
        height: glide ? ARTICLE_LIST_ACTIVE_HIGHLIGHT_GLIDE : ARTICLE_LIST_ACTIVE_HIGHLIGHT_SNAP,
        opacity: prefersReducedMotion ? ARTICLE_LIST_ACTIVE_HIGHLIGHT_SNAP : { duration: 0.16, ease: 'easeOut' },
      }}
    />
  );
});
