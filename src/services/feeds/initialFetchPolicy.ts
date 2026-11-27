import type { Feed } from '@/services/feeds/types';

export type FeedFetchHistoryFields = Pick<Feed, 'lastFetched' | 'lastFailedFetchAt'>;

/**
 * True when a feed has never completed or failed an HTTP fetch yet (e.g., right
 * after OPML import or adding a feed before its first sync).
 */
export function isFeedNeverFetched(feed: FeedFetchHistoryFields): boolean {
  return feed.lastFetched == null && feed.lastFailedFetchAt == null;
}

/**
 * True when `feedIds` is non-empty and at least one feed present in `feedById`
 * has never been fetched or failed yet.
 */
export function hasNeverFetchedFeedsInCatalog(
  feedIds: readonly string[],
  feedById: ReadonlyMap<string, FeedFetchHistoryFields>,
): boolean {
  if (feedIds.length === 0) {
    return false;
  }

  for (const feedId of feedIds) {
    const feed = feedById.get(feedId);
    if (feed && isFeedNeverFetched(feed)) {
      return true;
    }
  }

  return false;
}
