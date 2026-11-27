import * as feedStore from '@/stores/feedStore';
import type { Feed } from '@/services/feeds/types';
import { feedLibraryMutationBus } from '@/services/ui/feedLibraryMutationBus';

let cachedFeeds: Feed[] | null = null;
let cachedFeedMap: Map<string, Feed> | null = null;
let cacheRevision = 0;
let inFlight: Promise<Feed[]> | null = null;
let subscribed = false;

export function invalidateFeedMetadataCache(): void {
  cachedFeeds = null;
  cachedFeedMap = null;
  cacheRevision += 1;
}

const ensureInvalidationSubscription = (): void => {
  if (subscribed) {
    return;
  }
  subscribed = true;
  feedLibraryMutationBus.subscribe(() => {
    invalidateFeedMetadataCache();
  });
};

/**
 * Slim catalog for last-sync, station eligibility, and nested station rows.
 * Never uses feeds_list (favicon blobs). One in-flight IPC; drop the result
 * if a library mutation landed while it was in flight.
 */
export async function getAllFeedMetadataCached(): Promise<Feed[]> {
  ensureInvalidationSubscription();
  if (cachedFeeds !== null) {
    return cachedFeeds;
  }
  if (inFlight) {
    return inFlight;
  }

  const revision = cacheRevision;
  const pending: Promise<Feed[]> = feedStore.listSidebarSnapshot().then(
    (snapshot) => {
      if (inFlight === pending) {
        inFlight = null;
      }
      if (revision !== cacheRevision) {
        return getAllFeedMetadataCached();
      }
      cachedFeeds = snapshot.feeds;
      cachedFeedMap = null;
      return cachedFeeds;
    },
    (error: unknown) => {
      if (inFlight === pending) {
        inFlight = null;
      }
      throw error;
    },
  );
  inFlight = pending;
  return pending;
}

/**
 * Lazily indexes the cached slim catalog by feed ID once per cache revision
 * for O(1) lookup during station/feed switches with zero extra IPCs.
 */
export async function getFeedMetadataMapCached(): Promise<ReadonlyMap<string, Feed>> {
  const feeds = await getAllFeedMetadataCached();
  if (cachedFeeds === feeds && cachedFeedMap !== null) {
    return cachedFeedMap;
  }

  const map = new Map<string, Feed>();
  for (const feed of feeds) {
    map.set(feed.id, feed);
  }
  if (cachedFeeds === feeds) {
    cachedFeedMap = map;
  }
  return map;
}

export function getFeedMetadataCacheRevision(): number {
  return cacheRevision;
}

/** Test-only: drop cached metadata so mocks can vary per case. */
export function clearFeedMetadataCacheForTests(): void {
  cachedFeeds = null;
  cachedFeedMap = null;
  inFlight = null;
}
