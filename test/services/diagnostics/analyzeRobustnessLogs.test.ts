import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ANALYZER_PATH = path.resolve(process.cwd(), 'scripts/analyze-robustness-logs.mjs');

describe('analyze-robustness-logs', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('checks sidebarSwitch durations and flags slow cold switch skeleton waits', () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiji-robustness-log-'));
    tempDirs.push(logsDir);

    const logContent = [
      '[2026-11-27T10:00:00.000+08:00] [INFO] [renderer] [Renderer] Renderer bootstrap starting',
      'context={"windowType":"main"}',
      '[2026-11-27T10:01:00.000+08:00] [WARN] [renderer] [FeedContext] Slow cold switch skeleton wait',
      'context={"sourceType":"tag","sourceKey":"tag:Science","durationMs":9200,"initialFetchHold":true,"articleCount":12}',
      '[2026-11-27T10:10:00.000+08:00] [INFO] [renderer] [Robustness] Robustness counters',
      'context=' + JSON.stringify({
        event: 'robustness-counters',
        reason: 'interval',
        counters: {
          'sidebarSwitch.coldInitialFetchHold': 2,
          'sidebarSwitch.emptyWithoutRows': 1,
        },
        durations: {
          'sidebarSwitch.interactiveMs': { count: 4, avgMs: 25, maxMs: 60 },
          'sidebarSwitch.sqlitePageMs': { count: 4, avgMs: 18, maxMs: 42 },
          'sidebarSwitch.skeletonVisibleMs': { count: 3, avgMs: 3100, maxMs: 9200 },
          'sidebarSwitch.initialFetchWaitMs': { count: 2, avgMs: 4600, maxMs: 9100 },
        },
        native: {
          backoffSaturated: 0,
          bodyDecodedLossy: 0,
          bodyDecodedNonUtf8: 0,
          chunkFeedsSkippedMissing: 0,
          fetchCancelledNotRecorded: 0,
          itemsWithoutIdentity: 0,
          savedImportSkippedExisting: 0,
          storeTransactionRollbacks: 0,
        },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(logsDir, 'app-2026-11-27.log'), logContent);
    const jsonOut = path.join(logsDir, 'report.json');
    execFileSync('node', [ANALYZER_PATH, '--logs-dir', logsDir, '--date', '2026-11-27', '--json', jsonOut], {
      encoding: 'utf8',
    });

    const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    const byName = new Map(report.checks.map((check: { name: string; status: string; detail: string }) => [check.name, check]));
    expect(byName.get('Slow cold switch skeleton waits (>8s)')?.status).toBe('WARN');
    expect(byName.get('session 1 (2026-11-27T02:00:00.000Z): sidebar switch interactive latency')?.status).toBe('PASS');
    expect(byName.get('session 1 (2026-11-27T02:00:00.000Z): sidebar switch SQLite page latency')?.status).toBe('PASS');
    expect(byName.get('session 1 (2026-11-27T02:00:00.000Z): cold switch skeleton duration')?.status).toBe('PASS');
    expect(byName.get('session 1 (2026-11-27T02:00:00.000Z): initial-fetch skeleton wait')?.status).toBe('PASS');
  });
});
