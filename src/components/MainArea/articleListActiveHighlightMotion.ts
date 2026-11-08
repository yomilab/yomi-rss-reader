/**
 * The article list's active highlight: one filled block behind the active
 * (or keyboard) row that glides from row to row instead of each row drawing
 * its own background.
 */

/** Space under each row (`.article-list-item { margin-bottom }` in ArticleList.css). */
export const ARTICLE_LIST_ROW_GAP_PX = 2;

/**
 * Glide curve: a spring with no bounce, so the block eases in and settles
 * without overshooting. A spring keeps its speed when the target changes
 * mid-move, which keeps held j/k or arrow keys smooth.
 */
export const ARTICLE_LIST_ACTIVE_HIGHLIGHT_GLIDE = {
  type: 'spring',
  visualDuration: 0.32,
  bounce: 0,
} as const;

export const ARTICLE_LIST_ACTIVE_HIGHLIGHT_SNAP = { duration: 0 } as const;

export interface ArticleListRowMeasurement {
  index: number;
  start: number;
  size: number;
}

export interface ArticleListActiveHighlightRect {
  top: number;
  height: number;
}

/**
 * Where the block sits, in the list's scroll coordinates. Uses the
 * virtualizer's measurement for the row (known even when the row is not
 * mounted), else a mounted row, else nothing (the block hides).
 */
export function resolveArticleListActiveHighlightRect(
  index: number,
  measurements: ReadonlyArray<ArticleListRowMeasurement | undefined> | undefined,
  mountedRows: ReadonlyArray<ArticleListRowMeasurement>,
): ArticleListActiveHighlightRect | null {
  if (index < 0) return null;
  const row = measurements?.[index] ?? mountedRows.find((item) => item.index === index);
  if (!row || !Number.isFinite(row.start) || !Number.isFinite(row.size)) return null;
  return {
    top: row.start,
    height: Math.max(0, row.size - ARTICLE_LIST_ROW_GAP_PX),
  };
}

export interface ArticleListActiveHighlightMove {
  previousHash: string | null;
  nextHash: string | null;
  previousSourceKey: string;
  nextSourceKey: string;
  wasVisible: boolean;
  prefersReducedMotion: boolean;
}

/**
 * Glide only when the user moved to another row in the same list. Everything
 * else snaps: the first highlight, a new source, Reduce Motion, and the same
 * row changing place (new articles above it, a density change, an image
 * loading), where the rows themselves jump and a gliding block would lag.
 */
export function shouldGlideArticleListActiveHighlight({
  previousHash,
  nextHash,
  previousSourceKey,
  nextSourceKey,
  wasVisible,
  prefersReducedMotion,
}: ArticleListActiveHighlightMove): boolean {
  if (prefersReducedMotion || !wasVisible) return false;
  if (previousHash === null || nextHash === null) return false;
  if (previousSourceKey !== nextSourceKey) return false;
  return previousHash !== nextHash;
}
