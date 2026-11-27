import { tauriClient } from '@/lib/tauriClient';
import type { NativeRobustnessCounters } from '@/lib/tauriClient/contracts';
import { logger } from '@/services/logger';

/**
 * Session counters for robustness invariants (see kiji-doc
 * `docs/core/robustness-metrics.md`). Keys are a fixed union, so the store can
 * never grow across a long session. Every 10 minutes, when something changed,
 * one `Robustness counters` line is written to the app log with the renderer
 * counters, durations, and the Rust snapshot.
 */
export const ROBUSTNESS_COUNTER_KEYS = [
  'paintGate.fallbackStart',
  'frameYield.timeout',
  'feedContext.asyncPhaseFailed',
  'feedContext.nativeFailureNotReRecorded',
  'scheduler.reconfigureSkippedSameMode',
  'scheduler.countSyncFailed',
  'scheduler.cancelledFetchSkipped',
  'scheduler.stationPauseSafetyRelease',
  'scheduler.fullFollowUpCycle',
  'scheduler.interruptedScopeRestashed',
  'helperTasks.pendingCancelledOnClear',
  'opml.importPartialFailures',
  'savedZip.markdownMatched',
  'savedZip.markdownLegacyFallback',
  'savedZip.markdownMissing',
  'savedImport.skippedExisting',
  'sidebarFavicons.batchRequests',
  'sidebarFavicons.rowsHydrated',
  'ui.saveRaceViewUpdateSkipped',
  'ui.keyboardHoldReset',
  'ui.deleteFlowPartialFailure',
  'assistant.libraryChangeFailed',
  'sidebarSwitch.coldInitialFetchHold',
  'sidebarSwitch.emptyWithoutRows',
  'sidebarSwitch.cancelledDuringInitialFetch',
] as const;

export const ROBUSTNESS_DURATION_KEYS = [
  'scheduler.stationPauseHeldMs',
  'paintGate.waitMs',
  'sidebarFavicons.batchMs',
  'sidebarSwitch.interactiveMs',
  'sidebarSwitch.sqlitePageMs',
  'sidebarSwitch.skeletonVisibleMs',
  'sidebarSwitch.initialFetchWaitMs',
] as const;

export type RobustnessCounterKey = typeof ROBUSTNESS_COUNTER_KEYS[number];
export type RobustnessDurationKey = typeof ROBUSTNESS_DURATION_KEYS[number];

type DurationStats = { count: number; totalMs: number; maxMs: number };

const SUMMARY_INTERVAL_MS = 10 * 60_000;

const counters = new Map<RobustnessCounterKey, number>();
const durations = new Map<RobustnessDurationKey, DurationStats>();
let changedSinceLastSummary = false;

export function recordRobustnessEvent(key: RobustnessCounterKey, amount = 1): void {
  if (amount <= 0) {
    return;
  }
  counters.set(key, (counters.get(key) ?? 0) + amount);
  changedSinceLastSummary = true;
}

export function recordRobustnessDuration(key: RobustnessDurationKey, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }
  const stats = durations.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
  stats.count += 1;
  stats.totalMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);
  durations.set(key, stats);
  changedSinceLastSummary = true;
}

export function getRobustnessSnapshot(): {
  counters: Partial<Record<RobustnessCounterKey, number>>;
  durations: Partial<Record<RobustnessDurationKey, { count: number; avgMs: number; maxMs: number }>>;
} {
  const counterSnapshot: Partial<Record<RobustnessCounterKey, number>> = {};
  for (const [key, value] of counters) {
    counterSnapshot[key] = value;
  }
  const durationSnapshot: Partial<Record<RobustnessDurationKey, { count: number; avgMs: number; maxMs: number }>> = {};
  for (const [key, stats] of durations) {
    durationSnapshot[key] = {
      count: stats.count,
      avgMs: Math.round(stats.totalMs / stats.count),
      maxMs: Math.round(stats.maxMs),
    };
  }
  return { counters: counterSnapshot, durations: durationSnapshot };
}

const readNativeCounters = async (): Promise<NativeRobustnessCounters | null> => {
  try {
    return await tauriClient.diagnostics.robustnessCounters();
  } catch {
    return null;
  }
};

let lastNativeSignature: string | null = null;

export async function logRobustnessSummary(reason: 'interval' | 'teardown' = 'interval'): Promise<void> {
  const native = await readNativeCounters();
  const nativeSignature = native ? JSON.stringify(native) : null;
  const nativeChanged = nativeSignature !== null && nativeSignature !== lastNativeSignature;
  if (!changedSinceLastSummary && !nativeChanged) {
    return;
  }
  changedSinceLastSummary = false;
  lastNativeSignature = nativeSignature;
  logger.info('Robustness', 'Robustness counters', {
    event: 'robustness-counters',
    reason,
    ...getRobustnessSnapshot(),
    native,
  });
}

/** Starts the periodic summary; returns a stop function (one timer, cleared on stop). */
export function startRobustnessSummary(): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  const timerId = window.setInterval(() => {
    void logRobustnessSummary('interval');
  }, SUMMARY_INTERVAL_MS);
  return () => {
    window.clearInterval(timerId);
    void logRobustnessSummary('teardown');
  };
}

/** Test-only reset. */
export function resetRobustnessMetricsForTests(): void {
  counters.clear();
  durations.clear();
  changedSinceLastSummary = false;
  lastNativeSignature = null;
}
