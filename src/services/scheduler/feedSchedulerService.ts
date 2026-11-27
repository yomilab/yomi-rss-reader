import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { tauriClient } from '@/lib/tauriClient';
import { parseStructuredCommandError } from '@/lib/tauriClient/commandError';
import * as articleStore from '@/stores/articleStore';
import * as feedStore from '@/stores/feedStore';
import { feedRefreshActivity } from '@/services/feeds/feedRefreshActivity';
import { feedRefreshCoordinator } from '@/services/feeds/feedRefreshCoordinator';
import { feedsFetcher } from '@/services/feeds/feedsFetcher';
import { storeParsedFeedContent } from '@/services/feeds/feedRefreshPipeline';
import { maybeRefreshFavicon } from '@/services/favicons/faviconRefreshService';
import { settingsManager } from '@/services/settings';
import { createTaskPool } from '@/services/tasks/taskPool';
import { logger } from '@/services/logger';
import { invalidateFeedMetadataCache } from '@/services/feeds/feedMetadataCache';
import { feedLibraryMutationBus } from '@/services/ui/feedLibraryMutationBus';
import { recordRobustnessDuration, recordRobustnessEvent } from '@/services/diagnostics/robustnessMetrics';
import { getE2eConfig } from '@/services/e2e/e2eHarness';
import { createSchedulerRunPlan } from './schedulerRunPlan';
import { getSchedulerConcurrency, setSchedulerRuntimeUiState } from './schedulerConcurrency';
import type { SchedulerCycleScope } from './feedSchedulerServiceTypes';
import {
  collectFeedIdsNeedingCountSync,
  isNativeFeedIngestionEnabled,
} from './nativeSchedulerCycle';
import { runNativeFeedRefresh, type NativeFeedRefreshResult } from './nativeFeedRefresh';
import {
  mergePendingCycleReason,
  overdueCycleMs,
  shouldRunDeferredCycleNow,
  type PendingCycleReason,
} from './schedulerDeferredCyclePolicy';
import {
  shouldAcceptWake,
  type SchedulerWakePayload,
} from './schedulerWakeDedupe';
import type {
  BackgroundUpdateMode,
  FeedPriorityEntry,
  SchedulerEvent,
  SchedulerFeedEntry,
} from './types';

const SCHEDULER_CYCLE_TICK_EVENT = 'scheduler:cycle-tick';
const SCHEDULER_SYSTEM_SLEEP_EVENT = 'scheduler:system-sleep';
const SCHEDULER_SYSTEM_RESUME_EVENT = 'scheduler:system-resume';
const SCHEDULER_TICK_WAKE_GLOBAL = '__kijiSchedulerTick';
const SCHEDULER_SLEEP_WAKE_GLOBAL = '__kijiSchedulerSleep';
const SCHEDULER_RESUME_WAKE_GLOBAL = '__kijiSchedulerResume';
const STALE_CYCLE_ABORT_MS = 45 * 60 * 1_000;
const MAX_DEFERRED_TICKS_BEFORE_FORCE_ABORT = 3;
// Renderer-side sleep detection: JS timers freeze during system sleep, and the
// native sleep/resume events are not always delivered. A coarse heartbeat
// whose wall-clock delta far exceeds its interval means the machine slept —
// run the same catch-up path as a native resume event.
const SLEEP_GAP_HEARTBEAT_MS = 30_000;
const SLEEP_GAP_DETECT_MS = 120_000;
const STATION_SELECTION_PAUSE_MAX_MS = 10 * 60 * 1_000;
const STARTUP_CYCLE_IDLE_FALLBACK_MS = 30_000;
const BOOST_TTL_MS = 5 * 60_000;
// Long native cycles (post-import boosts over hundreds of feeds) commit
// inserts per feed in Rust but only report them in one batch at cycle end —
// the visible station and sidebar counts would stay empty for the whole
// cycle (a 557-feed import cycle measured ~3 minutes). Re-publish committed
// inserts in bounded windows so the list fills progressively; the cycle-end
// publish stays as the idempotent final flush.
const NATIVE_CYCLE_PROGRESS_PUBLISH_INTERVAL_MS = 2_000;

const MODE_INTERVAL_MS: Record<Exclude<BackgroundUpdateMode, 'on-launch' | 'never'>, number> = {
  'every-5m': 5 * 60_000,
  'every-10m': 10 * 60_000,
  'every-15m': 15 * 60_000,
  'every-30m': 30 * 60_000,
  'every-1h': 60 * 60_000,
};

interface SchedulerCycleStats {
  notModifiedFeeds: number;
  changedFeeds: number;
  insertedArticles: number;
  failedFeeds: number;
}

/** Unscoped (full-library) cycles; `excludeFeedIds` alone still covers the library. */
const isFullLibraryScope = (scope: SchedulerCycleScope): boolean => (
  !scope.onlyFeedIds || scope.onlyFeedIds.size === 0
);

interface ActiveStationFocus {
  sourceKey: string;
  feedIds: Set<string>;
}

class FeedSchedulerService {
  private cycleInProgress = false;
  private pendingCycleTick = false;
  private pendingCycleReason: PendingCycleReason | null = null;
  /**
   * Reason of an owed full-library (unscoped) cycle — an interrupted sync-all,
   * a deferred interval/startup/resume tick. Tracked apart from scoped
   * boost/import work so a scoped follow-up cannot consume it; cleared only
   * when an unscoped cycle starts. At most one full follow-up is ever owed.
   */
  private pendingFullCycleReason: PendingCycleReason | null = null;
  /** A scoped cycle ran while a full cycle was owed; the next full cycle is that follow-up. */
  private fullFollowUpPreserved = false;
  private abortController: AbortController | null = null;
  private lifecycleId = 0;
  private listeners = new Set<(event: SchedulerEvent) => void>();
  private mode: BackgroundUpdateMode = 'every-15m';
  private nativeDriverActive = false;
  /**
   * Mode last applied to the running native driver (`scheduler_start` /
   * `scheduler_reconfigure` resolved). Null while the driver is not known to
   * be running. Lets `reconfigure` ignore unrelated settings changes.
   */
  private nativeDriverMode: BackgroundUpdateMode | null = null;
  private nativeTickUnlisten: UnlistenFn | null = null;
  private lastCycleStartedAt: number | null = null;
  private lastCycleCompletedAt: number | null = null;
  private boosts = new Map<string, number>();
  private stationSelectionPauseDepth = 0;
  private stationSelectionPauseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock start of the current station pause (depth 0 → 1); null when not paused. */
  private stationSelectionPauseStartedAt: number | null = null;
  private activeStationFocus: ActiveStationFocus | null = null;
  private skipOnceFeedIds = new Set<string>();
  private pendingImportRefreshFeedIds: Set<string> | null = null;
  /** One-shot: paused/in-progress boostMany follow-up retries failure backoff. */
  private pendingImportRefreshBypassFailureBackoff = false;
  private consecutiveDeferredTicks = 0;
  private activeCycleId = 0;
  private activeCycleDrain: Promise<void> | null = null;
  private resolveActiveCycleDrain: (() => void) | null = null;
  private systemPowerUnlistenSleep: UnlistenFn | null = null;
  private systemPowerUnlistenResume: UnlistenFn | null = null;
  private deferStartupCycleUntilInteraction = false;
  private startupDeferTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredCycleRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepGapHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSleepGapHeartbeatAt = 0;
  /** Set after sleep or a cycle with no successful fetches; cleared on any changed/304 outcome. */
  private needsResumeCatchUp = false;
  private catchUpInFlight = false;
  private pendingCatchUpRerun = false;
  /** Native IPC cycle key (`native-${cycleId}`) while a native refresh is in flight. */
  private activeNativeCycleKey: string | null = null;
  /** Scope of the running cycle; null when idle or running a full-library cycle. */
  private activeCycleScope: SchedulerCycleScope | null = null;
  /** Feeds of the running cycle that already settled (bounded by its scope). */
  private activeCycleSettledFeedIds = new Set<string>();
  /** The running scoped cycle's unfinished feeds were already re-stashed by a pause. */
  private activeCycleScopeRestashed = false;
  /**
   * Unfinished feeds of a scoped (import / station boost) cycle that a station
   * pause interrupted. Runs as its own scoped cycle right after the pending
   * boost scope, so the new station's feeds still go first. Cleared when an
   * unscoped cycle starts (it covers these feeds).
   */
  private pendingInterruptedScope: { feedIds: Set<string>; bypassFailureBackoff: boolean } | null = null;

  on(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setRuntimeUiState(patch: Partial<{ scrollActive: boolean; articleViewOpen: boolean }>): void {
    setSchedulerRuntimeUiState(patch);
  }

  async start(): Promise<void> {
    this.clearAbort();
    const lifecycleId = ++this.lifecycleId;

    try {
      const settings = await settingsManager.getSettings();
      if (!this.isCurrentLifecycle(lifecycleId)) {
        return;
      }

      this.mode = settings.backgroundUpdate ?? 'every-15m';
      this.deferStartupCycleUntilInteraction = getE2eConfig() === null && !import.meta.env.VITEST;
      if (this.mode === 'never' || this.mode === 'on-launch') {
        this.clearSleepGapHeartbeat();
      } else {
        this.ensureSleepGapHeartbeat();
      }
      await this.ensureNativeTickListener(lifecycleId);
      await this.ensureSystemPowerListener(lifecycleId);
      this.registerNativeWakeHandlers();

      if (!this.isCurrentLifecycle(lifecycleId)) {
        return;
      }

      if (this.nativeDriverActive) {
        await this.ensureNativeDriverRunning(lifecycleId);
        await this.abortStaleLifecycle(lifecycleId);
        if (!this.isCurrentLifecycle(lifecycleId)) {
          return;
        }
        logger.info('Scheduler', 'Reconfigured native feed scheduler driver', { mode: this.mode });
        return;
      }

      const result = await tauriClient.scheduler.start({ mode: this.mode });
      await this.abortStaleLifecycle(lifecycleId);
      if (!this.isCurrentLifecycle(lifecycleId)) {
        return;
      }

      this.nativeDriverActive = true;
      this.nativeDriverMode = this.mode;
      logger.info('Scheduler', 'Started native feed scheduler driver', {
        mode: this.mode,
        result,
      });
    } catch (error) {
      await this.abortStaleLifecycle(lifecycleId);
      logger.error('Scheduler', 'Failed to start native feed scheduler driver', { error });
    }
  }

  pauseForStationSelection(): void {
    if (this.stationSelectionPauseDepth === 0) {
      logger.info('Scheduler', 'Pausing background refresh for station selection');
      this.stationSelectionPauseStartedAt = Date.now();
      if (this.cycleInProgress) {
        // An interrupted sync-all owes a full follow-up; an interrupted
        // scoped cycle owes only its unfinished feeds.
        if (!this.restashInterruptedScopedCycle()) {
          this.markPendingCycleTick('interval-tick');
        }
        this.invalidateActiveCycle();
        this.clearAbort();
        void this.cancelActiveNativeCycle();
        // Keep cycleInProgress until refreshAllFeeds finally clears it after drain.
      }
      this.stationSelectionPauseTimer = setTimeout(() => {
        this.releaseStationSelectionPause('timeout');
      }, STATION_SELECTION_PAUSE_MAX_MS);
    }

    this.stationSelectionPauseDepth += 1;
  }

  resumeAfterStationSelection(): void {
    if (this.stationSelectionPauseDepth === 0) {
      return;
    }

    this.stationSelectionPauseDepth -= 1;
    if (this.stationSelectionPauseDepth > 0) {
      return;
    }

    this.clearStationSelectionPauseTimer();
    this.recordStationSelectionPauseHeld();
    logger.info('Scheduler', 'Resuming background refresh after station selection');
    if (this.deferStartupCycleUntilInteraction) {
      this.ensureStartupDeferFallbackTimer(this.lifecycleId);
      return;
    }
    this.maybeRunDeferredCycle(this.lifecycleId);
  }

  releaseStationSelectionPause(reason: 'background' | 'timeout' | 'selection-changed'): void {
    if (this.stationSelectionPauseDepth === 0) {
      return;
    }

    this.clearStationSelectionPauseTimer();
    this.stationSelectionPauseDepth = 0;
    const heldMs = this.recordStationSelectionPauseHeld();
    logger.info('Scheduler', 'Released station-selection scheduler pause', { reason });
    if (reason === 'timeout') {
      recordRobustnessEvent('scheduler.stationPauseSafetyRelease');
      logger.warn('Scheduler', 'Station-selection scheduler pause hit the safety timeout', {
        heldMs,
        maxPauseMs: STATION_SELECTION_PAUSE_MAX_MS,
      });
    }

    if (reason === 'selection-changed') {
      // Preserve pending import boosts across selection hops; only clear the
      // interactive deferred tail. Import pending still owns the next tick.
      feedRefreshActivity.clearInteractiveRefreshDeferredTail();
      if (
        (this.pendingImportRefreshFeedIds && this.pendingImportRefreshFeedIds.size > 0)
        || this.pendingInterruptedScope
      ) {
        this.markPendingCycleTick('import-boost');
      } else if (this.shouldScheduleCatchUpCycle()) {
        this.markPendingCycleTick('catch-up');
      }
      return;
    }

    const lifecycleId = this.lifecycleId;
    if (this.deferStartupCycleUntilInteraction) {
      this.ensureStartupDeferFallbackTimer(lifecycleId);
      return;
    }
    if (this.pendingCycleTick || this.shouldScheduleCatchUpCycle()) {
      this.clearPendingCycleTick();
      void this.runScheduledCycle(lifecycleId, this.consumePendingImportRefreshScope());
      return;
    }

    this.maybeRunDeferredCycle(lifecycleId);
  }

  setActiveStationFocus(sourceKey: string, feedIds: string[]): void {
    this.activeStationFocus = {
      sourceKey,
      feedIds: new Set(feedIds),
    };
  }

  clearActiveStationFocus(sourceKey?: string): void {
    if (!this.activeStationFocus) {
      return;
    }

    if (sourceKey && this.activeStationFocus.sourceKey !== sourceKey) {
      return;
    }

    this.activeStationFocus = null;
  }

  suppressFeedsForNextCycle(feedIds: string[]): void {
    for (const feedId of feedIds) {
      this.skipOnceFeedIds.add(feedId);
    }
  }

  isStationSelectionPaused(): boolean {
    return this.isStationSelectionPausedInternal();
  }

  /** First sidebar interaction lifts startup cycle deferral (cycle still waits for selection pause). */
  acknowledgeSidebarInteraction(): void {
    if (!this.deferStartupCycleUntilInteraction) {
      return;
    }

    this.deferStartupCycleUntilInteraction = false;
    this.clearStartupDeferTimer();
    void this.ensureNativeDriverRunning(this.lifecycleId);
    logger.info('Scheduler', 'Startup background refresh deferral lifted after sidebar interaction');
  }

  /** Test-only: keep OnLaunch/interval ticks deferred until acknowledge or the 30s fallback. */
  setStartupCycleDeferredForTests(deferred: boolean): void {
    this.deferStartupCycleUntilInteraction = deferred;
    if (!deferred) {
      this.clearStartupDeferTimer();
    }
  }

  async stop(): Promise<void> {
    this.lifecycleId += 1;
    this.unregisterNativeWakeHandlers();
    this.clearAbort();
    this.clearDeferredCycleRetryTimer();
    this.clearSleepGapHeartbeat();
    this.cycleInProgress = false;
    this.clearAllPendingCycles();
    this.fullFollowUpPreserved = false;
    this.stationSelectionPauseDepth = 0;
    this.stationSelectionPauseStartedAt = null;
    this.clearStationSelectionPauseTimer();
    this.activeStationFocus = null;
    this.skipOnceFeedIds.clear();
    this.pendingImportRefreshFeedIds = null;
    this.pendingImportRefreshBypassFailureBackoff = false;
    this.pendingInterruptedScope = null;
    this.activeCycleScope = null;
    this.activeCycleSettledFeedIds.clear();
    this.activeCycleScopeRestashed = false;
    this.consecutiveDeferredTicks = 0;
    this.deferStartupCycleUntilInteraction = false;
    this.catchUpInFlight = false;
    this.pendingCatchUpRerun = false;
    this.clearStartupDeferTimer();
    this.invalidateActiveCycle();
    void this.cancelActiveNativeCycle();
    this.activeNativeCycleKey = null;
    this.finishCycleDrain();

    if (this.systemPowerUnlistenSleep) {
      this.systemPowerUnlistenSleep();
      this.systemPowerUnlistenSleep = null;
    }

    if (this.systemPowerUnlistenResume) {
      this.systemPowerUnlistenResume();
      this.systemPowerUnlistenResume = null;
    }

    if (this.nativeTickUnlisten) {
      this.nativeTickUnlisten();
      this.nativeTickUnlisten = null;
    }

    if (this.nativeDriverActive) {
      try {
        await tauriClient.scheduler.stop();
      } catch (error) {
        logger.warn('Scheduler', 'Failed to stop native feed scheduler driver', { error });
      }
      this.nativeDriverActive = false;
    }
    this.nativeDriverMode = null;

    logger.info('Scheduler', 'Stopped feed scheduler lifecycle');
  }

  async reconfigure(mode: BackgroundUpdateMode): Promise<void> {
    // `settings-changed` fires for every setting (theme, fonts, opacity...).
    // When the background mode is unchanged and the native driver already
    // runs with it, do nothing: cancelling the in-flight cycle and restarting
    // the driver (which emits a fresh OnLaunch tick) would turn every
    // cosmetic settings edit into a full-library refresh.
    if (
      mode === this.mode
      && this.nativeDriverActive
      && this.nativeDriverMode === mode
    ) {
      recordRobustnessEvent('scheduler.reconfigureSkippedSameMode');
      logger.debug('Scheduler', 'Skipped same-mode scheduler reconfigure', { mode });
      return;
    }

    this.mode = mode;
    this.invalidateActiveCycle();
    void this.cancelActiveNativeCycle();
    this.clearAbort();
    const lifecycleId = ++this.lifecycleId;
    logger.info('Scheduler', 'Reconfigured feed scheduler lifecycle', { mode });

    try {
      await tauriClient.scheduler.reconfigure({ mode });
      if (!this.isCurrentLifecycle(lifecycleId)) {
        return;
      }
      this.nativeDriverActive = true;
      this.nativeDriverMode = mode;
    } catch (error) {
      logger.error('Scheduler', 'Failed to reconfigure native feed scheduler driver', { error });
    }
  }

  async catchUpAfterResume(): Promise<void> {
    if (this.catchUpInFlight) {
      this.pendingCatchUpRerun = true;
      return;
    }

    this.catchUpInFlight = true;
    try {
      do {
        this.pendingCatchUpRerun = false;
        await this.runCatchUpAfterResumeOnce();
      } while (this.pendingCatchUpRerun);
    } finally {
      this.catchUpInFlight = false;
    }
  }

  private async runCatchUpAfterResumeOnce(): Promise<void> {
    if (this.mode === 'never' || this.mode === 'on-launch') {
      return;
    }

    const lifecycleId = this.lifecycleId;
    if (!this.isCurrentLifecycle(lifecycleId)) {
      return;
    }

    if (this.deferStartupCycleUntilInteraction) {
      if (this.shouldScheduleCatchUpCycle()) {
        this.markPendingCycleTick('resume');
      }
      this.ensureStartupDeferFallbackTimer(lifecycleId);
      // Keep the native timer alive across sleep during the 30s idle window;
      // do not run a cycle until a real click or the fallback lifts deferral.
      await this.ensureNativeDriverRunning(lifecycleId);
      return;
    }

    await this.ensureNativeDriverRunning(lifecycleId);
    if (!this.isCurrentLifecycle(lifecycleId)) {
      return;
    }

    if (this.isStationSelectionPaused()) {
      if (this.shouldScheduleCatchUpCycle()) {
        this.markPendingCycleTick('resume');
      }
      return;
    }

    if (this.cycleInProgress) {
      if (this.shouldAbortStaleCycle()) {
        await this.forceAbortActiveCycle('resume');
      } else {
        if (this.shouldScheduleCatchUpCycle()) {
          this.markPendingCycleTick('resume');
        }
        return;
      }
    }

    // Sleep / focus / failed overnight cycles set needsResumeCatchUp so a brief
    // power-nap failure does not satisfy the interval and skip the real wake.
    const wasOverdue = this.shouldScheduleCatchUpCycle() || this.pendingCycleTick;
    if (!wasOverdue) {
      return;
    }

    await this.runResumeCatchUpCycles(lifecycleId, wasOverdue);
  }

  async handleSystemSleep(): Promise<void> {
    const lifecycleId = this.lifecycleId;
    if (!this.isCurrentLifecycle(lifecycleId)) {
      return;
    }

    logger.info('Scheduler', 'Handling system sleep for background refresh');
    if (this.cycleInProgress) {
      await this.forceAbortActiveCycle('system-sleep');
    }
  }

  private async runResumeCatchUpCycles(lifecycleId: number, wasOverdue: boolean): Promise<void> {
    const stationFeedIds = this.activeStationFocus?.feedIds;
    const intervalMs = this.getIntervalMs();
    const overdueMs = this.lastCycleCompletedAt === null
      ? intervalMs
      : Date.now() - this.lastCycleCompletedAt;
    // Overnight dark-wake failures leave feeds in backoff; resume must retry them.
    const resumeScope = { bypassFailureBackoff: true as const };

    if (wasOverdue && stationFeedIds && stationFeedIds.size > 0) {
      logger.info('Scheduler', 'Running station-first catch-up after resume', {
        mode: this.mode,
        overdueMs,
        stationFeedCount: stationFeedIds.size,
        bypassFailureBackoff: true,
        needsResumeCatchUp: this.needsResumeCatchUp,
      });
      // The rest-of-library pass below is the full cycle; do not let the
      // station-first scoped run re-arm an owed full cycle ahead of it.
      this.clearAllPendingCycles();
      await this.runScheduledCycle(lifecycleId, {
        ...resumeScope,
        onlyFeedIds: stationFeedIds,
      });
      if (!this.isCurrentLifecycle(lifecycleId)) {
        return;
      }
    }

    if (!wasOverdue && !this.pendingCycleTick) {
      return;
    }

    logger.info('Scheduler', 'Running catch-up background refresh after resume', {
      mode: this.mode,
      overdueMs,
      pendingCycleTick: this.pendingCycleTick,
      bypassFailureBackoff: true,
      needsResumeCatchUp: this.needsResumeCatchUp,
    });
    this.clearAllPendingCycles();
    await this.runScheduledCycle(lifecycleId, {
      ...resumeScope,
      excludeFeedIds: stationFeedIds && stationFeedIds.size > 0 ? stationFeedIds : undefined,
    });
  }

  /**
   * Detects system sleep via wall-clock jumps between heartbeats. Timers
   * freeze during sleep, so a beat whose delta far exceeds the interval means
   * the machine slept; native sleep/resume events are not reliably delivered
   * (observed in production logs), so this is the fallback trigger for the
   * resume catch-up path. Single interval per scheduler session; cleared on
   * `stop()`.
   */
  private ensureSleepGapHeartbeat(): void {
    if (this.sleepGapHeartbeatTimer !== null) {
      return;
    }

    this.lastSleepGapHeartbeatAt = Date.now();
    this.sleepGapHeartbeatTimer = setInterval(() => {
      const now = Date.now();
      const gapMs = now - this.lastSleepGapHeartbeatAt;
      this.lastSleepGapHeartbeatAt = now;
      if (gapMs < SLEEP_GAP_DETECT_MS) {
        return;
      }

      logger.warn('Scheduler', 'Detected system sleep gap via wall-clock jump', {
        gapMs,
        mode: this.mode,
      });
      // Mark before catch-up so a recent all-failed cycle does not look "fresh".
      this.needsResumeCatchUp = true;
      void this.catchUpAfterResume();
    }, SLEEP_GAP_HEARTBEAT_MS);
  }

  private clearSleepGapHeartbeat(): void {
    if (this.sleepGapHeartbeatTimer !== null) {
      clearInterval(this.sleepGapHeartbeatTimer);
      this.sleepGapHeartbeatTimer = null;
    }
  }

  private pruneExpiredBoosts(now = Date.now()): void {
    for (const [feedId, boostUntil] of this.boosts) {
      if (boostUntil <= now) {
        this.boosts.delete(feedId);
      }
    }
  }

  private markPendingCycleTick(reason: PendingCycleReason): void {
    this.pendingCycleTick = true;
    this.pendingCycleReason = mergePendingCycleReason(this.pendingCycleReason, reason);
    if (reason !== 'import-boost') {
      // Every non-boost reason owes a full-library pass; boosts only owe the
      // scoped feeds in pendingImportRefreshFeedIds.
      this.pendingFullCycleReason = mergePendingCycleReason(this.pendingFullCycleReason, reason);
    }
  }

  /**
   * Clears the scoped/boost pending tick. An owed full-library cycle survives
   * (re-armed under its own reason) until an unscoped cycle actually starts,
   * so a station-scoped boost run cannot consume the interrupted sync-all.
   */
  private clearPendingCycleTick(): void {
    if (this.pendingFullCycleReason !== null) {
      this.pendingCycleTick = true;
      this.pendingCycleReason = this.pendingFullCycleReason;
      return;
    }
    this.pendingCycleTick = false;
    this.pendingCycleReason = null;
  }

  private clearAllPendingCycles(): void {
    this.pendingCycleTick = false;
    this.pendingCycleReason = null;
    this.pendingFullCycleReason = null;
  }

  private recordStationSelectionPauseHeld(): number | null {
    const startedAt = this.stationSelectionPauseStartedAt;
    this.stationSelectionPauseStartedAt = null;
    if (startedAt === null) {
      return null;
    }
    const heldMs = Math.max(0, Date.now() - startedAt);
    recordRobustnessDuration('scheduler.stationPauseHeldMs', heldMs);
    return heldMs;
  }

  private clearDeferredCycleRetryTimer(): void {
    if (this.deferredCycleRetryTimer !== null) {
      clearTimeout(this.deferredCycleRetryTimer);
      this.deferredCycleRetryTimer = null;
    }
  }

  private scheduleDeferredCycleRetry(lifecycleId: number): void {
    if (this.deferredCycleRetryTimer !== null) {
      return;
    }

    const intervalMs = this.getIntervalMs();
    if (!Number.isFinite(intervalMs)) {
      return;
    }

    const remainingMs = Math.max(
      1_000,
      intervalMs - overdueCycleMs(this.lastCycleCompletedAt, intervalMs),
    );

    this.deferredCycleRetryTimer = setTimeout(() => {
      this.deferredCycleRetryTimer = null;
      this.maybeRunDeferredCycle(lifecycleId);
    }, remainingMs);
  }

  boostMany(feedIds: string[]): void {
    if (feedIds.length === 0) {
      return;
    }

    const boostUntil = Date.now() + BOOST_TTL_MS;
    this.pruneExpiredBoosts(boostUntil);
    for (const feedId of feedIds) {
      this.boosts.set(feedId, boostUntil);
    }

    const importScope: SchedulerCycleScope = {
      onlyFeedIds: new Set(feedIds),
    };

    if (this.cycleInProgress || this.isStationSelectionPaused()) {
      this.markPendingCycleTick('import-boost');
      this.mergePendingImportRefreshFeedIds(feedIds);
      this.pendingImportRefreshBypassFailureBackoff = true;

      // A cycle that spans a system sleep can stall for hours; a boost is a
      // user-intent signal (station switch, import), so preempt the stale
      // cycle instead of deferring the refresh behind it. Fire-and-forget —
      // boostMany stays synchronous on the selection click path.
      if (!this.isStationSelectionPaused() && this.shouldAbortStaleCycle()) {
        const lifecycleId = this.lifecycleId;
        logger.warn('Scheduler', 'Preempting stale refresh cycle for boosted feeds', {
          feedCount: feedIds.length,
        });
        void this.forceAbortActiveCycle('boost-preempt').then(() => {
          if (
            !this.isCurrentLifecycle(lifecycleId)
            || this.cycleInProgress
            || this.isStationSelectionPaused()
            || this.deferStartupCycleUntilInteraction
          ) {
            return;
          }
          this.clearPendingCycleTick();
          void this.runScheduledCycle(lifecycleId, this.consumePendingImportRefreshScope());
        });
        return;
      }

      logger.info('Scheduler', this.isStationSelectionPaused()
        ? 'Deferred boosted import refresh during station selection'
        : 'Deferred boosted import refresh until current cycle completes', {
        feedCount: feedIds.length,
      });
      return;
    }

    if (this.deferStartupCycleUntilInteraction) {
      this.markPendingCycleTick('import-boost');
      this.mergePendingImportRefreshFeedIds(feedIds);
      this.pendingImportRefreshBypassFailureBackoff = true;
      this.ensureStartupDeferFallbackTimer(this.lifecycleId);
      logger.info('Scheduler', 'Deferred boosted import refresh until startup sidebar interaction', {
        feedCount: feedIds.length,
      });
      return;
    }

    logger.info('Scheduler', 'Boosted feed priorities after import', {
      feedCount: feedIds.length,
    });

    void this.runScheduledCycle(this.lifecycleId, importScope);
  }

  private mergePendingImportRefreshFeedIds(feedIds: Iterable<string>): void {
    if (!this.pendingImportRefreshFeedIds) {
      this.pendingImportRefreshFeedIds = new Set(feedIds);
      return;
    }

    for (const feedId of feedIds) {
      this.pendingImportRefreshFeedIds.add(feedId);
    }
  }

  /**
   * Re-stashes the unfinished feeds of the running scoped cycle when a station
   * pause aborts it. Returns false for a full-library cycle (the caller owes a
   * full follow-up instead).
   */
  private restashInterruptedScopedCycle(): boolean {
    const scope = this.activeCycleScope;
    if (!scope?.onlyFeedIds || isFullLibraryScope(scope)) {
      return false;
    }
    if (this.activeCycleScopeRestashed) {
      return true;
    }
    this.activeCycleScopeRestashed = true;

    const remainingFeedIds = [...scope.onlyFeedIds].filter(
      (feedId) => !this.activeCycleSettledFeedIds.has(feedId),
    );
    if (remainingFeedIds.length === 0) {
      return true;
    }

    if (!this.pendingInterruptedScope) {
      this.pendingInterruptedScope = { feedIds: new Set(), bypassFailureBackoff: false };
    }
    for (const feedId of remainingFeedIds) {
      this.pendingInterruptedScope.feedIds.add(feedId);
    }
    if (scope.bypassFailureBackoff === true) {
      this.pendingInterruptedScope.bypassFailureBackoff = true;
    }
    this.markPendingCycleTick('import-boost');
    recordRobustnessEvent('scheduler.interruptedScopeRestashed');
    logger.info('Scheduler', 'Re-stashed unfinished feeds of interrupted scoped refresh cycle', {
      remainingFeedCount: remainingFeedIds.length,
      scopedFeedCount: scope.onlyFeedIds.size,
      bypassFailureBackoff: scope.bypassFailureBackoff === true,
    });
    return true;
  }

  private consumePendingImportRefreshScope(): SchedulerCycleScope {
    if (!this.pendingImportRefreshFeedIds || this.pendingImportRefreshFeedIds.size === 0) {
      this.pendingImportRefreshBypassFailureBackoff = false;
      const interrupted = this.pendingInterruptedScope;
      if (!interrupted) {
        return {};
      }
      this.pendingInterruptedScope = null;
      return interrupted.bypassFailureBackoff
        ? { onlyFeedIds: interrupted.feedIds, bypassFailureBackoff: true }
        : { onlyFeedIds: interrupted.feedIds };
    }

    const onlyFeedIds = this.pendingImportRefreshFeedIds;
    const bypassFailureBackoff = this.pendingImportRefreshBypassFailureBackoff;
    this.pendingImportRefreshFeedIds = null;
    this.pendingImportRefreshBypassFailureBackoff = false;
    return bypassFailureBackoff
      ? { onlyFeedIds, bypassFailureBackoff: true }
      : { onlyFeedIds };
  }

  private clearStartupDeferTimer(): void {
    if (this.startupDeferTimer !== null) {
      clearTimeout(this.startupDeferTimer);
      this.startupDeferTimer = null;
    }
  }

  private ensureStartupDeferFallbackTimer(lifecycleId: number): void {
    if (this.startupDeferTimer !== null || !this.deferStartupCycleUntilInteraction) {
      return;
    }

    this.startupDeferTimer = setTimeout(() => {
      this.startupDeferTimer = null;
      if (!this.isCurrentLifecycle(lifecycleId) || !this.deferStartupCycleUntilInteraction) {
        return;
      }

      this.deferStartupCycleUntilInteraction = false;
      logger.info('Scheduler', 'Startup background refresh deferral expired; scheduling idle catch-up');
      void this.ensureNativeDriverRunning(lifecycleId).then(() => {
        if (!this.isCurrentLifecycle(lifecycleId)) {
          return;
        }
        this.maybeRunDeferredCycle(lifecycleId);
      });
    }, STARTUP_CYCLE_IDLE_FALLBACK_MS);
  }

  private isStationSelectionPausedInternal(): boolean {
    return this.stationSelectionPauseDepth > 0;
  }

  private shouldScheduleCatchUpCycle(): boolean {
    if (this.pendingCycleTick || this.needsResumeCatchUp) {
      return true;
    }

    const intervalMs = this.getIntervalMs();
    const overdueMs = this.lastCycleCompletedAt === null
      ? intervalMs
      : Date.now() - this.lastCycleCompletedAt;
    return overdueMs >= intervalMs;
  }

  private noteCycleFetchOutcome(stats: {
    changedFeeds: number;
    notModifiedFeeds: number;
    failedFeeds: number;
    executedFeedCount: number;
  }, isFullCycle: boolean): void {
    if (stats.changedFeeds > 0 || stats.notModifiedFeeds > 0) {
      // Only a full-library pass makes the library "fresh"; a scoped station
      // or import run must not satisfy resume catch-up for everything else.
      if (isFullCycle) {
        this.needsResumeCatchUp = false;
      }
      return;
    }

    // All attempted feeds failed, or every feed was skipped (e.g. backoff) —
    // keep retrying on the next sleep gap / window focus / resume.
    if (stats.failedFeeds > 0 || stats.executedFeedCount === 0) {
      this.needsResumeCatchUp = true;
    }
  }

  private maybeRunDeferredCycle(lifecycleId: number): void {
    if (this.deferStartupCycleUntilInteraction) {
      this.ensureStartupDeferFallbackTimer(lifecycleId);
      return;
    }

    if (
      !this.pendingCycleTick
      || this.cycleInProgress
      || !this.isCurrentLifecycle(lifecycleId)
      || this.isStationSelectionPaused()
    ) {
      return;
    }

    const reason = this.pendingCycleReason ?? 'interval-tick';
    const intervalMs = this.getIntervalMs();
    if (!shouldRunDeferredCycleNow({
      reason,
      lastCycleCompletedAt: this.lastCycleCompletedAt,
      intervalMs,
    })) {
      logger.info('Scheduler', 'Deferred native scheduler tick coalesced until interval overdue', {
        mode: this.mode,
        reason,
        overdueMs: overdueCycleMs(this.lastCycleCompletedAt, intervalMs),
        intervalMs,
      });
      this.scheduleDeferredCycleRetry(lifecycleId);
      return;
    }

    this.clearDeferredCycleRetryTimer();
    this.clearPendingCycleTick();
    logger.info('Scheduler', 'Running deferred native scheduler tick', { mode: this.mode, reason });
    void this.runScheduledCycle(lifecycleId, this.consumePendingImportRefreshScope());
  }

  private getIntervalMs(): number {
    const e2eConfig = getE2eConfig();
    if (e2eConfig?.schedulerIntervalMs && e2eConfig.schedulerIntervalMs > 0) {
      return e2eConfig.schedulerIntervalMs;
    }

    if (this.mode === 'on-launch' || this.mode === 'never') {
      return Number.POSITIVE_INFINITY;
    }
    return MODE_INTERVAL_MS[this.mode];
  }

  private registerNativeWakeHandlers(): void {
    if (typeof globalThis === 'undefined') {
      return;
    }

    const globalScope = globalThis as Record<string, unknown>;
    globalScope[SCHEDULER_TICK_WAKE_GLOBAL] = (payload?: SchedulerWakePayload) => {
      if (!this.acceptWakeOrLog(payload, 'eval', 'tick')) {
        return;
      }
      void this.handleNativeCycleTick(this.lifecycleId);
    };
    globalScope[SCHEDULER_SLEEP_WAKE_GLOBAL] = (payload?: SchedulerWakePayload) => {
      if (!this.acceptWakeOrLog(payload, 'eval', 'sleep')) {
        return;
      }
      void this.handleSystemSleep();
    };
    globalScope[SCHEDULER_RESUME_WAKE_GLOBAL] = (payload?: SchedulerWakePayload) => {
      if (!this.acceptWakeOrLog(payload, 'eval', 'resume')) {
        return;
      }
      this.needsResumeCatchUp = true;
      void this.catchUpAfterResume();
    };
  }

  private acceptWakeOrLog(
    payload: SchedulerWakePayload | null | undefined,
    channel: 'event' | 'eval',
    kind: string,
  ): boolean {
    if (shouldAcceptWake(payload, channel)) {
      return true;
    }

    logger.info('Scheduler', 'Dropped duplicate scheduler wake', {
      event: 'scheduler-wake-deduped',
      channel,
      kind: payload?.kind ?? kind,
      wakeId: payload?.wakeId,
      driverGeneration: payload?.driverGeneration,
    });
    return false;
  }

  private extractWakePayload(payload: unknown): SchedulerWakePayload | undefined {
    if (
      payload
      && typeof payload === 'object'
      && typeof (payload as SchedulerWakePayload).wakeId === 'number'
      && typeof (payload as SchedulerWakePayload).driverGeneration === 'number'
    ) {
      return payload as SchedulerWakePayload;
    }
    return undefined;
  }

  private unregisterNativeWakeHandlers(): void {
    if (typeof globalThis === 'undefined') {
      return;
    }

    const globalScope = globalThis as Record<string, unknown>;
    delete globalScope[SCHEDULER_TICK_WAKE_GLOBAL];
    delete globalScope[SCHEDULER_SLEEP_WAKE_GLOBAL];
    delete globalScope[SCHEDULER_RESUME_WAKE_GLOBAL];
  }

  private async ensureNativeDriverRunning(lifecycleId: number): Promise<void> {
    if (
      !this.isCurrentLifecycle(lifecycleId)
      || !this.nativeDriverActive
      || this.mode === 'never'
      || this.mode === 'on-launch'
    ) {
      return;
    }

    const mode = this.mode;
    try {
      await tauriClient.scheduler.reconfigure({ mode });
      if (this.isCurrentLifecycle(lifecycleId) && this.nativeDriverActive) {
        this.nativeDriverMode = mode;
      }
    } catch (error) {
      logger.warn('Scheduler', 'Failed to ensure native feed scheduler driver is running', { error });
    }
  }

  private async ensureNativeTickListener(lifecycleId: number): Promise<void> {
    if (this.nativeTickUnlisten) {
      return;
    }

    const unlisten = await listen(SCHEDULER_CYCLE_TICK_EVENT, (event) => {
      const payload = this.extractWakePayload(event?.payload);
      if (!this.acceptWakeOrLog(payload, 'event', 'tick')) {
        return;
      }
      void this.handleNativeCycleTick(this.lifecycleId);
    });

    if (!this.isCurrentLifecycle(lifecycleId)) {
      unlisten();
      // StrictMode / overlapping start(): only clear if we still own the slot.
      if (this.nativeTickUnlisten === unlisten) {
        this.nativeTickUnlisten = null;
      }
      return;
    }

    this.nativeTickUnlisten = unlisten;
  }

  private async handleNativeCycleTick(lifecycleId: number): Promise<void> {
    if (!this.isCurrentLifecycle(lifecycleId)) {
      return;
    }

    if (this.deferStartupCycleUntilInteraction) {
      this.markPendingCycleTick('startup-defer');
      this.ensureStartupDeferFallbackTimer(lifecycleId);
      logger.info('Scheduler', 'Deferred startup background refresh until sidebar interaction', {
        mode: this.mode,
      });
      return;
    }

    if (this.isStationSelectionPaused()) {
      this.markPendingCycleTick('interval-tick');
      logger.info('Scheduler', 'Deferred native scheduler tick during station selection', {
        mode: this.mode,
      });
      return;
    }

    if (this.cycleInProgress) {
      if (this.shouldAbortStaleCycle()) {
        await this.forceAbortActiveCycle('deferred-tick');
      } else {
        this.markPendingCycleTick('interval-tick');
        this.consecutiveDeferredTicks += 1;
        logger.info('Scheduler', 'Deferred native scheduler tick until current refresh cycle completes', {
          mode: this.mode,
          consecutiveDeferredTicks: this.consecutiveDeferredTicks,
        });
        return;
      }
    }

    this.consecutiveDeferredTicks = 0;
    await this.runScheduledCycle(lifecycleId);
  }

  private async abortStaleLifecycle(lifecycleId: number): Promise<void> {
    if (this.isCurrentLifecycle(lifecycleId)) {
      return;
    }

    try {
      await tauriClient.scheduler.stop();
    } catch (error) {
      logger.warn('Scheduler', 'Failed to stop native driver for stale lifecycle', { error });
    }
    this.nativeDriverActive = false;
    this.nativeDriverMode = null;
  }

  private async runScheduledCycle(
    lifecycleId: number,
    scope: SchedulerCycleScope = {},
  ): Promise<void> {
    if (!this.isCurrentLifecycle(lifecycleId) || this.cycleInProgress) {
      return;
    }

    if (this.isStationSelectionPaused()) {
      this.markPendingCycleTick('interval-tick');
      return;
    }

    await this.refreshAllFeeds(lifecycleId, scope);
  }

  private getStaleCycleThresholdMs(): number {
    const intervalMs = this.getIntervalMs();
    if (!Number.isFinite(intervalMs)) {
      return STALE_CYCLE_ABORT_MS;
    }
    return Math.min(STALE_CYCLE_ABORT_MS, intervalMs * 2);
  }

  private shouldAbortStaleCycle(): boolean {
    if (!this.cycleInProgress) {
      return false;
    }

    if (this.consecutiveDeferredTicks >= MAX_DEFERRED_TICKS_BEFORE_FORCE_ABORT) {
      return true;
    }

    const startedAt = this.lastCycleStartedAt;
    if (startedAt === null) {
      return false;
    }

    return Date.now() - startedAt >= this.getStaleCycleThresholdMs();
  }

  private beginCycleDrain(): void {
    this.finishCycleDrain();
    this.activeCycleDrain = new Promise<void>((resolve) => {
      this.resolveActiveCycleDrain = resolve;
    });
  }

  private finishCycleDrain(): void {
    this.resolveActiveCycleDrain?.();
    this.resolveActiveCycleDrain = null;
    this.activeCycleDrain = null;
  }

  private async awaitCycleDrain(): Promise<void> {
    const drain = this.activeCycleDrain;
    if (!drain) {
      return;
    }
    await drain;
  }

  private invalidateActiveCycle(): void {
    this.activeCycleId += 1;
  }

  private async forceAbortActiveCycle(trigger: string): Promise<boolean> {
    const wasActive = this.cycleInProgress || this.activeCycleDrain !== null;
    if (!wasActive) {
      return false;
    }

    const stallDurationMs = this.lastCycleStartedAt === null
      ? 0
      : Date.now() - this.lastCycleStartedAt;

    logger.warn('Scheduler', 'Aborting stale background refresh cycle', {
      trigger,
      mode: this.mode,
      stallDurationMs,
      consecutiveDeferredTicks: this.consecutiveDeferredTicks,
    });

    this.invalidateActiveCycle();
    this.clearAbort();
    void this.cancelActiveNativeCycle();
    this.consecutiveDeferredTicks = 0;
    this.markPendingCycleTick('interval-tick');
    // Do not clear cycleInProgress here — await drain and let refreshAllFeeds finally clear it.
    await this.awaitCycleDrain();
    return true;
  }

  private async ensureSystemPowerListener(lifecycleId: number): Promise<void> {
    if (this.systemPowerUnlistenSleep && this.systemPowerUnlistenResume) {
      return;
    }

    const sleepUnlisten = await listen(SCHEDULER_SYSTEM_SLEEP_EVENT, (event) => {
      const payload = this.extractWakePayload(event?.payload);
      if (!this.acceptWakeOrLog(payload, 'event', 'sleep')) {
        return;
      }
      void this.handleSystemSleep();
    });
    const resumeUnlisten = await listen(SCHEDULER_SYSTEM_RESUME_EVENT, (event) => {
      const payload = this.extractWakePayload(event?.payload);
      if (!this.acceptWakeOrLog(payload, 'event', 'resume')) {
        return;
      }
      this.needsResumeCatchUp = true;
      void this.catchUpAfterResume();
    });

    if (!this.isCurrentLifecycle(lifecycleId)) {
      sleepUnlisten();
      resumeUnlisten();
      if (this.systemPowerUnlistenSleep === sleepUnlisten) {
        this.systemPowerUnlistenSleep = null;
      }
      if (this.systemPowerUnlistenResume === resumeUnlisten) {
        this.systemPowerUnlistenResume = null;
      }
      return;
    }

    this.systemPowerUnlistenSleep = sleepUnlisten;
    this.systemPowerUnlistenResume = resumeUnlisten;
  }

  private clearStationSelectionPauseTimer(): void {
    if (this.stationSelectionPauseTimer !== null) {
      clearTimeout(this.stationSelectionPauseTimer);
      this.stationSelectionPauseTimer = null;
    }
  }

  private clearAbort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async cancelActiveNativeCycle(): Promise<void> {
    const cycleKey = this.activeNativeCycleKey;
    if (!cycleKey) {
      return;
    }

    try {
      await tauriClient.scheduler.cancelNativeCycle({ cycleId: cycleKey });
    } catch (error) {
      logger.warn('Scheduler', 'Failed to cancel native refresh cycle', {
        cycleId: cycleKey,
        error,
      });
    }
  }

  private isCurrentLifecycle(lifecycleId: number): boolean {
    return lifecycleId === this.lifecycleId;
  }

  private async refreshAllFeeds(
    lifecycleId: number,
    scope: SchedulerCycleScope = {},
  ): Promise<void> {
    if (this.cycleInProgress || !this.isCurrentLifecycle(lifecycleId)) {
      return;
    }

    const cycleId = this.activeCycleId + 1;
    this.activeCycleId = cycleId;
    this.clearDeferredCycleRetryTimer();
    const scopedTailGeneration = scope.onlyFeedIds && scope.onlyFeedIds.size > 0
      ? feedRefreshActivity.getInteractiveRefreshScopeGeneration()
      : undefined;
    const pendingReason = this.pendingCycleReason;
    const queueDepth = this.pendingCycleTick ? 1 : 0;
    const isFullCycle = isFullLibraryScope(scope);
    if (isFullCycle) {
      if (this.fullFollowUpPreserved) {
        this.fullFollowUpPreserved = false;
        recordRobustnessEvent('scheduler.fullFollowUpCycle');
        logger.info('Scheduler', 'Running preserved full-library follow-up cycle', {
          mode: this.mode,
          cycleId,
          pendingReason,
        });
      }
      this.clearAllPendingCycles();
      // A full-library pass also covers an interrupted scoped remainder.
      this.pendingInterruptedScope = null;
    } else {
      if (this.pendingFullCycleReason !== null) {
        this.fullFollowUpPreserved = true;
      }
      // Keeps an owed full cycle armed for after this scoped run.
      this.clearPendingCycleTick();
      if (this.pendingInterruptedScope) {
        // The interrupted remainder runs right after this scoped cycle.
        this.markPendingCycleTick('import-boost');
      }
    }
    this.activeCycleScope = isFullCycle ? null : scope;
    this.activeCycleSettledFeedIds.clear();
    this.activeCycleScopeRestashed = false;
    this.beginCycleDrain();
    this.cycleInProgress = true;
    this.lastCycleStartedAt = Date.now();
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    this.emit({ type: 'cycle-start', cycleId });
    logger.info('Scheduler', 'Background refresh cycle started', {
      mode: this.mode,
      cycleId,
      queueDepth,
      pendingReason,
      scopedFeedCount: scope.onlyFeedIds?.size ?? null,
      excludedFeedCount: scope.excludeFeedIds?.size ?? null,
    });

    const cycleStats: SchedulerCycleStats = {
      notModifiedFeeds: 0,
      changedFeeds: 0,
      insertedArticles: 0,
      failedFeeds: 0,
    };
    const feedsNeedingCountSync = new Set<string>();

    try {
      if (isNativeFeedIngestionEnabled()) {
        await this.executeNativeRefreshCycle({
          lifecycleId,
          cycleId,
          scope,
          signal,
        });
        return;
      }

      const feeds = await feedStore.getAll();
      if (feeds.length === 0 || signal.aborted || !this.isCurrentLifecycle(lifecycleId)) {
        return;
      }

      if (cycleId !== this.activeCycleId) {
        return;
      }

      const totalFeeds = feeds.length;
      const entries: SchedulerFeedEntry[] = feeds.map((feed) => ({
        feedId: feed.id,
        feedUrl: feed.url,
        feedTitle: feed.title,
        lastFetched: feed.lastFetched ?? null,
        lastFailedFetchAt: feed.lastFailedFetchAt ?? null,
        sortOrder: feed.sortOrder ?? 0,
        updateFrequencyScore: feed.updateFrequencyScore ?? 0,
        consecutiveFailures: feed.consecutiveFailures ?? 0,
      }));

      const frontloadFeedIds = scope.onlyFeedIds ?? this.activeStationFocus?.feedIds;
      const skipFeedIdsForThisCycle = this.consumeSkipOnceFeedIds(scope);
      const now = Date.now();
      this.pruneExpiredBoosts(now);
      const { prioritized, skippedBackoffCount, skippedSuppressedCount } = createSchedulerRunPlan(
        entries,
        totalFeeds,
        this.boosts,
        now,
        {
          frontloadFeedIds,
          skipFeedIdsForThisCycle,
          onlyFeedIds: scope.onlyFeedIds,
          excludeFeedIds: scope.excludeFeedIds,
          bypassFailureBackoff: scope.bypassFailureBackoff,
        },
      );

      const releaseQueuedFeeds = prioritized.length > 0
        ? feedRefreshActivity.beginQueuedFeeds(prioritized.map((entry) => entry.feedId), 'background')
        : null;

      try {
        const pool = createTaskPool({ concurrency: getSchedulerConcurrency() });
        for (const entry of prioritized) {
          if (signal.aborted || !this.isCurrentLifecycle(lifecycleId) || cycleId !== this.activeCycleId) {
            break;
          }
          pool.enqueue(() => this.fetchSingleFeed(
            entry,
            signal,
            lifecycleId,
            cycleStats,
            releaseQueuedFeeds,
            feedsNeedingCountSync,
          ));
        }

        await pool.whenIdle();

        if (
          feedsNeedingCountSync.size > 0
          && !signal.aborted
          && this.isCurrentLifecycle(lifecycleId)
          && cycleId === this.activeCycleId
        ) {
          await this.syncAndPublishFeedCounts(Array.from(feedsNeedingCountSync), cycleId);
        }
      } finally {
        releaseQueuedFeeds?.();
      }

      this.noteCycleFetchOutcome({
        changedFeeds: cycleStats.changedFeeds,
        notModifiedFeeds: cycleStats.notModifiedFeeds,
        failedFeeds: cycleStats.failedFeeds,
        executedFeedCount: prioritized.length,
      }, isFullCycle);

      logger.info('Scheduler', 'Background refresh cycle stats', {
        totalFeeds,
        scheduledFeeds: prioritized.length,
        skippedBackoffFeeds: skippedBackoffCount,
        skippedSuppressedFeeds: skippedSuppressedCount,
        activeStationFeedCount: frontloadFeedIds?.size ?? 0,
        cycleId,
        ...cycleStats,
      });
    } catch (error) {
      logger.error('Scheduler', 'Background refresh cycle failed', { error, cycleId });
      this.needsResumeCatchUp = true;
    } finally {
      const durationMs = this.lastCycleStartedAt === null
        ? null
        : Date.now() - this.lastCycleStartedAt;
      this.finishCycleDrain();
      this.activeCycleScope = null;
      this.activeCycleSettledFeedIds.clear();
      this.activeCycleScopeRestashed = false;

      const wasSuperseded = cycleId !== this.activeCycleId;
      // Always clear the in-progress flag once this cycle drains — pause/abort
      // no longer clear it early so overlapping logical starts stay bounded.
      this.cycleInProgress = false;
      this.abortController = null;

      if (wasSuperseded) {
        logger.info('Scheduler', 'Discarded superseded background refresh cycle completion', {
          mode: this.mode,
          cycleId,
          activeCycleId: this.activeCycleId,
        });
        if (scope.onlyFeedIds && scope.onlyFeedIds.size > 0) {
          feedRefreshActivity.clearInteractiveRefreshDeferredTail(scopedTailGeneration);
        }
        this.maybeRunDeferredCycle(lifecycleId);
        return;
      }

      // Only a completed full-library pass makes the library fresh for the
      // interval-overdue / catch-up checks; scoped station or import runs do not.
      if (isFullCycle) {
        this.lastCycleCompletedAt = Date.now();
      }
      this.consecutiveDeferredTicks = 0;
      this.emit({ type: 'cycle-complete', cycleId });
      logger.info('Scheduler', 'Background refresh cycle completed', {
        mode: this.mode,
        cycleId,
        durationMs,
        fullLibrary: isFullCycle,
      });

      if (scope.onlyFeedIds && scope.onlyFeedIds.size > 0) {
        feedRefreshActivity.clearInteractiveRefreshDeferredTail(scopedTailGeneration);
      }

      this.maybeRunDeferredCycle(lifecycleId);
    }
  }

  private async executeNativeRefreshCycle(input: {
    lifecycleId: number;
    cycleId: number;
    scope: SchedulerCycleScope;
    signal: AbortSignal;
  }): Promise<void> {
    const { lifecycleId, cycleId, scope, signal } = input;
    const frontloadFeedIds = scope.onlyFeedIds ?? this.activeStationFocus?.feedIds;
    const skipFeedIdsForThisCycle = this.consumeSkipOnceFeedIds(scope);
    const now = Date.now();
    this.pruneExpiredBoosts(now);
    const nativeCycleKey = `native-${cycleId}`;
    this.activeNativeCycleKey = nativeCycleKey;
    const progressPublisher = this.createNativeCycleProgressPublisher(cycleId);

    try {
      if (signal.aborted || !this.isCurrentLifecycle(lifecycleId) || cycleId !== this.activeCycleId) {
        return;
      }

      const result = await runNativeFeedRefresh({
        scope,
        boosts: this.boosts,
        frontloadFeedIds,
        skipFeedIdsForThisCycle,
        signal,
        activityKind: 'background',
        cycleId: nativeCycleKey,
        onFeedComplete: (payload) => {
          if (cycleId === this.activeCycleId) {
            this.activeCycleSettledFeedIds.add(payload.feedId);
          }
          if (!payload.error) {
            progressPublisher.noteFeedInserted(payload.feedId, payload.insertedCount);
            return;
          }

          this.emit({
            type: 'feed-failed',
            feedId: payload.feedId,
            error: payload.error,
          });
        },
      });

      if (!this.isCurrentLifecycle(lifecycleId)) {
        return;
      }

      if (result.feedResults.length > 0) {
        invalidateFeedMetadataCache();
      }

      // The native IPC has no cancellation channel, so a superseded cycle
      // still ran to completion in Rust and committed per-feed inserts and
      // ETags. Publish those committed results instead of dropping them —
      // otherwise the next cycle sees all-304, emits nothing, and the visible
      // list stays stale even though rows already exist in SQLite (observed
      // as the post-import skeleton timing out onto an empty list).
      if (signal.aborted || cycleId !== this.activeCycleId) {
        await this.publishCommittedCycleResults(result, cycleId);
        logger.info('Scheduler', 'Published committed results from superseded native refresh cycle', {
          cycleId,
          activeCycleId: this.activeCycleId,
          insertedFeedCount: result.insertedByFeedId.size,
          insertedArticles: result.insertedArticles,
        });
        return;
      }

      await this.publishCommittedCycleResults(result, cycleId);

      const changedFeeds = result.feedResults.filter((feed) => feed.status === 'changed').length;
      const notModifiedFeeds = result.feedResults.filter((feed) => feed.status === 'not-modified').length;
      const failedFeeds = result.feedResults.filter((feed) => feed.status === 'failed').length;
      const cancelledFeeds = result.feedResults.filter((feed) => (
        feed.error !== undefined
        && parseStructuredCommandError(feed.error)?.code === 'FEED_REQUEST_CANCELLED'
      )).length;
      this.noteCycleFetchOutcome({
        changedFeeds,
        notModifiedFeeds,
        failedFeeds,
        executedFeedCount: result.feedResults.length,
      }, isFullLibraryScope(scope));

      logger.info('Scheduler', 'Native background refresh cycle stats', {
        cycleId,
        queuedCount: result.feedResults.length,
        executedFeedCount: result.feedResults.length,
        changedFeeds,
        notModifiedFeeds,
        failedFeeds,
        cancelledFeeds,
        insertedArticles: result.insertedArticles,
        activeStationFeedCount: frontloadFeedIds?.size ?? 0,
        bypassFailureBackoff: scope.bypassFailureBackoff === true,
      });
    } catch (error) {
      logger.error('Scheduler', 'Native background refresh cycle failed', { error, cycleId });
      this.needsResumeCatchUp = true;
    } finally {
      await progressPublisher.dispose();
      if (this.activeNativeCycleKey === nativeCycleKey) {
        this.activeNativeCycleKey = null;
      }
    }
  }

  /**
   * Progressive mid-cycle publishing for long native cycles. Per-feed insert
   * results accumulate and re-publish (count sync + `feeds-batch-updated`) at
   * most once per NATIVE_CYCLE_PROGRESS_PUBLISH_INTERVAL_MS. Emissions are
   * idempotent against the cycle-end publish: FeedContext merges pending
   * updates with Math.max and the count sync is a pure recompute.
   */
  private createNativeCycleProgressPublisher(cycleId: number): {
    noteFeedInserted: (feedId: string, insertedCount?: number | null) => void;
    dispose: () => Promise<void>;
  } {
    const pendingInsertedByFeedId = new Map<string, number>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushInFlight = false;

    const flush = async (options?: { force?: boolean }): Promise<void> => {
      if (flushInFlight || pendingInsertedByFeedId.size === 0) {
        return;
      }
      // Mid-cycle flushes only while this cycle is still the active one;
      // dispose may force one final publish after supersede so committed
      // inserts still reach the UI keyed by this cycleId.
      if (!options?.force && cycleId !== this.activeCycleId) {
        return;
      }
      flushInFlight = true;
      const batch = new Map(pendingInsertedByFeedId);
      pendingInsertedByFeedId.clear();

      try {
        const syncedCounts = await articleStore.syncFeedCountsBatch(Array.from(batch.keys()));
        if (syncedCounts.length > 0) {
          feedLibraryMutationBus.publishFeedsCountsUpdated(
            syncedCounts.map((counts) => ({
              feedId: counts.feedId,
              unreadCount: counts.unreadCount,
              articleCount: counts.articleCount,
            })),
          );
        }

        this.emit({
          type: 'feeds-batch-updated',
          cycleId,
          updates: Array.from(batch, ([feedId, newArticleCount]) => ({
            feedId,
            newArticleCount,
          })),
        });
      } catch (error) {
        logger.warn('Scheduler', 'Failed to publish native cycle insert progress', {
          error,
          cycleId,
        });
      } finally {
        flushInFlight = false;
      }
    };

    return {
      noteFeedInserted: (feedId, insertedCount) => {
        if (!insertedCount || insertedCount <= 0) {
          return;
        }
        pendingInsertedByFeedId.set(
          feedId,
          Math.max(pendingInsertedByFeedId.get(feedId) ?? 0, insertedCount),
        );
        if (flushTimer !== null) {
          return;
        }
        flushTimer = setTimeout(() => {
          flushTimer = null;
          void flush();
        }, NATIVE_CYCLE_PROGRESS_PUBLISH_INTERVAL_MS);
      },
      dispose: async () => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (pendingInsertedByFeedId.size > 0) {
          await flush({ force: true });
        }
      },
    };
  }

  private async publishCommittedCycleResults(
    result: NativeFeedRefreshResult,
    cycleId: number,
  ): Promise<void> {
    const feedIdsToSync = collectFeedIdsNeedingCountSync(result.feedResults);
    if (feedIdsToSync.length > 0) {
      await this.syncAndPublishFeedCounts(feedIdsToSync, cycleId);
    }

    // Native cycles bypass the per-feed `feed-updated` emit in the legacy
    // path; without this batch event the article list is never re-queried
    // after a background cycle inserts articles (list stays stale until the
    // next cold switch).
    if (result.insertedByFeedId.size > 0) {
      this.emit({
        type: 'feeds-batch-updated',
        cycleId,
        updates: Array.from(result.insertedByFeedId, ([feedId, newArticleCount]) => ({
          feedId,
          newArticleCount,
        })),
      });
    }
  }

  /**
   * Recompute sidebar counts after a cycle's inserts are already committed.
   * A count-sync failure must not fail the cycle: the articles exist in
   * SQLite, so list refresh events and the cycle fetch outcome still apply,
   * and counts self-heal on the next sync.
   */
  private async syncAndPublishFeedCounts(feedIds: string[], cycleId: number): Promise<void> {
    let syncedCounts: Awaited<ReturnType<typeof articleStore.syncFeedCountsBatch>>;
    try {
      syncedCounts = await articleStore.syncFeedCountsBatch(feedIds);
    } catch (error) {
      recordRobustnessEvent('scheduler.countSyncFailed');
      logger.warn('Scheduler', 'Failed to sync feed counts after refresh cycle', {
        error,
        cycleId,
        feedCount: feedIds.length,
      });
      return;
    }

    if (syncedCounts.length > 0) {
      feedLibraryMutationBus.publishFeedsCountsUpdated(
        syncedCounts.map((counts) => ({
          feedId: counts.feedId,
          unreadCount: counts.unreadCount,
          articleCount: counts.articleCount,
        })),
      );
    }
  }

  private async fetchSingleFeed(
    entry: FeedPriorityEntry,
    signal: AbortSignal,
    lifecycleId: number,
    cycleStats: SchedulerCycleStats,
    releaseQueuedFeeds: ((feedId?: string) => void) | null,
    feedsNeedingCountSync: Set<string>,
  ): Promise<void> {
    let queuedFeedReleased = false;
    const settleQueuedFeed = (): void => {
      if (queuedFeedReleased || !releaseQueuedFeeds) {
        return;
      }
      queuedFeedReleased = true;
      releaseQueuedFeeds(entry.feedId);
    };

    if (signal.aborted || !this.isCurrentLifecycle(lifecycleId)) {
      settleQueuedFeed();
      return;
    }

    try {
      await feedRefreshCoordinator.run(entry.feedId, async () => {
        if (signal.aborted || !this.isCurrentLifecycle(lifecycleId)) {
          settleQueuedFeed();
          return;
        }

        const feed = await feedStore.getById(entry.feedId);
        if (!feed || signal.aborted) {
          settleQueuedFeed();
          return;
        }

        const networkResult = await feedRefreshActivity.track(
          entry.feedId,
          () => feedsFetcher.fetchFeedNetworkWithCache(entry.feedUrl, {
            etag: feed.etag,
            lastModified: feed.lastModifiedHeader,
            signal,
          }),
        );
        settleQueuedFeed();

        if (signal.aborted || !this.isCurrentLifecycle(lifecycleId)) {
          return;
        }

        if (networkResult.notModified || !networkResult.data) {
          await feedStore.update(entry.feedId, {
            lastFetched: new Date(),
            lastFailedFetchAt: undefined,
            consecutiveFailures: 0,
            etag: networkResult.etag,
            lastModifiedHeader: networkResult.lastModified,
          });
          cycleStats.notModifiedFeeds += 1;
          this.activeCycleSettledFeedIds.add(entry.feedId);
          return;
        }

        const stored = await storeParsedFeedContent({
          feedId: entry.feedId,
          feedUrl: entry.feedUrl,
          feed,
          feedTitle: entry.feedTitle,
          rawText: networkResult.data,
          signal,
        });
        if (signal.aborted || !this.isCurrentLifecycle(lifecycleId)) {
          return;
        }

        cycleStats.changedFeeds += 1;
        cycleStats.insertedArticles += stored.insertedCount;
        feedsNeedingCountSync.add(entry.feedId);
        this.activeCycleSettledFeedIds.add(entry.feedId);

        await feedStore.update(entry.feedId, {
          lastFetched: new Date(),
          lastFailedFetchAt: undefined,
          updateFrequencyScore: stored.updateFrequencyScore ?? feed.updateFrequencyScore,
          consecutiveFailures: 0,
          etag: networkResult.etag,
          lastModifiedHeader: networkResult.lastModified,
        });

        void maybeRefreshFavicon(entry.feedId, entry.feedUrl);
        this.emit({ type: 'feed-updated', feedId: entry.feedId, newArticleCount: stored.insertedCount });
      }, { signal });
    } catch (error) {
      settleQueuedFeed();

      // A cancelled cycle is not a feed failure. Tauri-cancelled fetches reject
      // with the raw FEED_REQUEST_CANCELLED command error (not an AbortError),
      // so also honour the cycle signal and the structured cancel code.
      if (
        signal.aborted
        || (error instanceof Error && error.name === 'AbortError')
        || parseStructuredCommandError(error)?.code === 'FEED_REQUEST_CANCELLED'
      ) {
        recordRobustnessEvent('scheduler.cancelledFetchSkipped');
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      cycleStats.failedFeeds += 1;
      this.activeCycleSettledFeedIds.add(entry.feedId);
      logger.warn('Scheduler', 'Feed fetch failed in scheduler cycle', {
        feedId: entry.feedId,
        error: message,
      });

      await feedStore.update(entry.feedId, {
        consecutiveFailures: (entry.consecutiveFailures ?? 0) + 1,
        lastFailedFetchAt: new Date(),
      });

      this.emit({ type: 'feed-failed', feedId: entry.feedId, error: message });
    }
  }

  private consumeSkipOnceFeedIds(scope: SchedulerCycleScope): Set<string> | undefined {
    if (this.skipOnceFeedIds.size === 0) {
      return undefined;
    }

    // A scoped run ahead of an owed full follow-up only consumes the
    // suppressions inside its scope; the rest stay for that full cycle.
    if (!isFullLibraryScope(scope) && this.pendingFullCycleReason !== null && scope.onlyFeedIds) {
      const skipFeedIds = new Set<string>();
      for (const feedId of scope.onlyFeedIds) {
        if (this.skipOnceFeedIds.delete(feedId)) {
          skipFeedIds.add(feedId);
        }
      }
      return skipFeedIds.size > 0 ? skipFeedIds : undefined;
    }

    const skipFeedIds = new Set(this.skipOnceFeedIds);
    this.skipOnceFeedIds.clear();
    return skipFeedIds;
  }

  private emit(event: SchedulerEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}

export const feedScheduler = new FeedSchedulerService();
