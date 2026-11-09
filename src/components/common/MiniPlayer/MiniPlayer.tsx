import React, { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

import './MiniPlayer.css';
import { useAudioPlayback } from '@/hooks/useAudioPlayback';
import { useDependencyEffect, useUnmountEffect } from '@/hooks/useLifecycleEffects';
import {
  audioPlaybackService,
  formatPlaybackRate,
  formatPlaybackTime,
  SKIP_BACK_SECONDS,
  SKIP_FORWARD_SECONDS,
  type AudioTrack,
} from '@/services/audio/audioPlaybackService';
import { AUDIO_ICONS, skipIconSvg } from '@/components/common/AudioPlayer/audioIcons';
import { useMiniPlayerDrag } from './useMiniPlayerDrag';

interface MiniPlayerProps {
  /** Opens the episode's article; returns false when it is not reachable. */
  onOpenArticle?: (articleHash: string) => void;
  canOpenArticle?: (articleHash: string) => boolean;
}

/** Pointer leaving for less than this does not fold the controls away. */
const COLLAPSE_DELAY_MS = 250;

/** Keyboard focus keeps the controls open; a mouse click's focus does not. */
function isKeyboardFocus(target: EventTarget | null): boolean {
  try {
    return target instanceof Element && target.matches(':focus-visible');
  } catch {
    return false;
  }
}

const Icon: React.FC<{ path: string }> = ({ path }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>
);

const SkipIcon: React.FC<{ seconds: number; direction: 'back' | 'forward' }> = ({ seconds, direction }) => (
  <span className="mini-player-skip-icon" dangerouslySetInnerHTML={{ __html: skipIconSvg(seconds, direction) }} />
);

const Artwork: React.FC<{ track: AudioTrack; size: 'pill' | 'row' }> = ({ track, size }) => {
  const [failed, setFailed] = useState(false);
  useDependencyEffect(() => setFailed(false), [track.artwork]);
  return (
    <span className={`mini-player-art mini-player-art-${size}`} aria-hidden="true">
      {track.artwork && !failed
        ? <img src={track.artwork} alt="" onError={() => setFailed(true)} />
        : <Icon path={AUDIO_ICONS.waveform} />}
    </span>
  );
};

function describeTrack(track: AudioTrack, isCurrent: boolean, position: number, duration: number): string {
  const parts: string[] = [];
  if (track.subtitle) parts.push(track.subtitle);
  if (duration > 0) {
    const left = Math.max(0, duration - position);
    if (isCurrent || position > 0) {
      parts.push(left < 1 ? 'Played' : `${formatPlaybackTime(left)} left`);
    } else {
      parts.push(formatPlaybackTime(duration));
    }
  }
  return parts.join(' · ');
}

export const MiniPlayer: React.FC<MiniPlayerProps> = ({
  onOpenArticle,
  canOpenArticle,
}) => {
  const playback = useAudioPlayback();
  const [queueOpen, setQueueOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Collapsed it shows the episode and play/pause; hovering spreads the rest out.
  const drag = useMiniPlayerDrag(hovered || queueOpen || keyboardFocused);
  const expanded = drag.expanded;

  const cancelCollapse = useCallback(() => {
    if (collapseTimerRef.current !== null) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);
  const onPointerEnter = useCallback(() => {
    cancelCollapse();
    setHovered(true);
  }, [cancelCollapse]);
  const onPointerLeave = useCallback(() => {
    cancelCollapse();
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null;
      setHovered(false);
    }, COLLAPSE_DELAY_MS);
  }, [cancelCollapse]);
  useUnmountEffect(cancelCollapse);

  // Stays up while the episode's own article is open, so the queue is always reachable.
  const current = playback.queue.find((track) => track.id === playback.currentId) ?? null;
  const visible = !!current;

  useDependencyEffect(() => {
    if (!queueOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.('.mini-player')) setQueueOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQueueOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [queueOpen]);

  useDependencyEffect(() => {
    if (visible) return;
    setQueueOpen(false);
    setHovered(false);
    setKeyboardFocused(false);
  }, [visible]);

  const isPlaying = playback.status === 'playing' || playback.status === 'loading';
  const progress = playback.duration > 0 ? Math.min(100, (playback.position / playback.duration) * 100) : 0;
  const articleHash = current?.articleHash;
  const titleOpensArticle = !!articleHash && !!onOpenArticle && (canOpenArticle?.(articleHash) ?? true);

  return (
    <AnimatePresence>
      {visible && current && (
        <motion.div
          key="mini-player"
          className="mini-player"
          role="region"
          aria-label="Now playing"
          data-component="mini-player"
          data-status={playback.status}
          data-expanded={expanded ? 'true' : 'false'}
          data-dragging={drag.dragging ? 'true' : undefined}
          data-queue-placement={drag.queueLayout.placement}
          style={{ right: drag.position.right, bottom: drag.position.bottom }}
          onClickCapture={drag.onClickCapture}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onFocus={(event) => setKeyboardFocused(isKeyboardFocus(event.target))}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyboardFocused(false);
          }}
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ type: 'tween', duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }}
        >
          <AnimatePresence>
            {queueOpen && (
              <motion.div
                key="queue"
                className="mini-player-queue"
                role="dialog"
                aria-label="Listening queue"
                data-component="mini-player-queue"
                style={{ maxHeight: drag.queueLayout.maxHeight }}
                initial={{ opacity: 0, y: drag.queueLayout.placement === 'above' ? 6 : -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: drag.queueLayout.placement === 'above' ? 6 : -6 }}
                transition={{ type: 'tween', duration: 0.14 }}
              >
                <div className="mini-player-queue-header">
                  <span>Queue</span>
                  <button type="button" className="mini-player-text-button" onClick={() => audioPlaybackService.clear()}>
                    Clear all
                  </button>
                </div>
                <ul className="mini-player-queue-list">
                  {playback.queue.map((track) => {
                    const isCurrent = track.id === playback.currentId;
                    const position = audioPlaybackService.getSavedPosition(track.id);
                    const duration = audioPlaybackService.getKnownDuration(track.id);
                    return (
                      <li key={track.id} className={`mini-player-queue-row ${isCurrent ? 'is-current' : ''}`}>
                        <button
                          type="button"
                          className="mini-player-queue-play"
                          aria-current={isCurrent ? 'true' : undefined}
                          onClick={() => (isCurrent ? audioPlaybackService.toggle() : audioPlaybackService.play(track))}
                        >
                          <Artwork track={track} size="row" />
                          <span className="mini-player-queue-text">
                            <span className="mini-player-queue-title">{track.title}</span>
                            <span className="mini-player-queue-meta">
                              {isCurrent && <span className="mini-player-live">{isPlaying ? 'Playing' : 'Paused'}</span>}
                              {describeTrack(track, isCurrent, position, duration)}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="mini-player-icon-button mini-player-queue-remove"
                          aria-label={`Remove ${track.title} from queue`}
                          onClick={() => audioPlaybackService.remove(track.id)}
                        >
                          <Icon path={AUDIO_ICONS.close} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </motion.div>
            )}
          </AnimatePresence>

          <div
            className="mini-player-pill"
            data-component="mini-player-pill"
            onPointerDown={drag.onPointerDown}
          >
            <Artwork track={current} size="pill" />
            <button
              type="button"
              className="mini-player-text"
              disabled={!titleOpensArticle}
              onClick={() => articleHash && onOpenArticle?.(articleHash)}
              title={titleOpensArticle ? 'Open episode' : undefined}
            >
              <span className="mini-player-title">{current.title}</span>
              <span className="mini-player-meta">
                {playback.failed
                  ? 'Couldn’t play this episode'
                  : describeTrack(current, true, playback.position, playback.duration)}
              </span>
            </button>
            <div className="mini-player-controls">
              <div className="mini-player-more mini-player-more-lead">
                <button
                  type="button"
                  className="mini-player-icon-button"
                  aria-label={`Back ${SKIP_BACK_SECONDS} seconds`}
                  onClick={() => audioPlaybackService.skipBy(-SKIP_BACK_SECONDS)}
                >
                  <SkipIcon seconds={SKIP_BACK_SECONDS} direction="back" />
                </button>
              </div>
              <button
                type="button"
                className="mini-player-icon-button mini-player-play"
                aria-label={isPlaying ? 'Pause' : 'Play'}
                onClick={() => audioPlaybackService.toggle()}
                data-component="mini-player-toggle"
              >
                <Icon path={isPlaying ? AUDIO_ICONS.pause : AUDIO_ICONS.play} />
              </button>
              <div className="mini-player-more mini-player-more-trail">
                <button
                  type="button"
                  className="mini-player-icon-button"
                  aria-label={`Forward ${SKIP_FORWARD_SECONDS} seconds`}
                  onClick={() => audioPlaybackService.skipBy(SKIP_FORWARD_SECONDS)}
                >
                  <SkipIcon seconds={SKIP_FORWARD_SECONDS} direction="forward" />
                </button>
                <span className="mini-player-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="mini-player-rate"
                  aria-label="Playback speed"
                  onClick={() => audioPlaybackService.cycleRate()}
                >
                  {formatPlaybackRate(playback.rate)}
                </button>
                <button
                  type="button"
                  className={`mini-player-icon-button mini-player-queue-toggle ${queueOpen ? 'is-active' : ''}`}
                  aria-label="Queue"
                  aria-expanded={queueOpen}
                  onClick={() => setQueueOpen((open) => !open)}
                >
                  <Icon path={AUDIO_ICONS.queue} />
                  {playback.queue.length > 1 && (
                    <span className="mini-player-badge">{playback.queue.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="mini-player-icon-button"
                  aria-label="Stop and close player"
                  onClick={() => audioPlaybackService.clear()}
                >
                  <Icon path={AUDIO_ICONS.close} />
                </button>
              </div>
            </div>
            <span className="mini-player-progress" aria-hidden="true" style={{ width: `${progress}%` }} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
