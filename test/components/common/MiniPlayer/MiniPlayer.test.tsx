import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('howler', async () => {
  const { createFakeSoundFactory } = await import('../../../services/audio/fakeSound');
  const { factory } = createFakeSoundFactory();
  return {
    Howl: class {
      constructor(options: Parameters<typeof factory>[0]) {
        return factory(options);
      }
    },
  };
});

// jsdom has no PointerEvent; without it fireEvent drops pointerId / clientX.
if (typeof window.PointerEvent === 'undefined') {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}

const overlay = vi.hoisted(() => ({
  activeArticleHash: null as string | null,
  articleViewOverlayPhase: 'closed' as string,
  selectArticle: () => {},
}));

vi.mock('@/contexts/FeedContext', () => ({
  useFeedCollectionArticles: () => ({ articles: [{ hash: 'hash-a' }, { hash: 'hash-b' }] }),
  useFeedOverlay: () => overlay,
}));

import { MiniPlayer } from '@/components/common/MiniPlayer/MiniPlayer';
import { MiniPlayerHost } from '@/components/common/MiniPlayer/MiniPlayerHost';
import { MINI_PLAYER_STORAGE_KEY } from '@/components/common/MiniPlayer/useMiniPlayerDrag';
import { audioPlaybackService } from '@/services/audio/audioPlaybackService';

const first = { src: 'https://example.com/a.mp3', title: 'First episode', articleHash: 'hash-a' };
const second = { src: 'https://example.com/b.mp3', title: 'Second episode', articleHash: 'hash-b' };

describe('MiniPlayer', () => {
  afterEach(() => {
    cleanup();
    act(() => audioPlaybackService.clear());
    localStorage.clear();
    overlay.activeArticleHash = null;
    overlay.articleViewOverlayPhase = 'closed';
  });

  it('stays hidden until something plays', () => {
    render(<MiniPlayer />);
    expect(screen.queryByRole('region', { name: 'Now playing' })).toBeNull();
  });

  it('stays on screen when an episode starts from its own open article', () => {
    overlay.activeArticleHash = 'hash-a';
    overlay.articleViewOverlayPhase = 'open';
    render(<MiniPlayerHost />);

    act(() => audioPlaybackService.play(first));

    expect(screen.getByRole('region', { name: 'Now playing' })).toBeTruthy();
    expect(screen.getByText('First episode')).toBeTruthy();
  });

  it('shows an episode added to the queue while nothing plays', () => {
    render(<MiniPlayer />);
    act(() => audioPlaybackService.enqueue(first));

    expect(screen.getByRole('region', { name: 'Now playing' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  });

  it('drags anywhere in the window, remembers the spot and swallows the release click', () => {
    render(<MiniPlayer />);
    act(() => audioPlaybackService.play(first));
    const region = screen.getByRole('region', { name: 'Now playing' });
    const pill = region.querySelector('[data-component="mini-player-pill"]')!;
    const toggle = screen.getByRole('button', { name: 'Pause' });

    fireEvent.pointerDown(toggle, { button: 0, pointerId: 1, clientX: 500, clientY: 700 });
    act(() => {
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 400 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 200 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 300, clientY: 200 });
    });
    fireEvent.click(toggle);

    expect(pill).toBeTruthy();
    expect(region.style.right).toBe('214px');
    expect(region.style.bottom).toBe('514px');
    expect(region.dataset.queuePlacement).toBe('below');
    expect(JSON.parse(localStorage.getItem(MINI_PLAYER_STORAGE_KEY)!)).toEqual({ right: 214, bottom: 514 });
    // The click that ended the drag did not pause playback.
    expect(audioPlaybackService.getSnapshot().status).not.toBe('paused');
  });

  it('keeps the pill inside the window and still clicks on a press without movement', () => {
    render(<MiniPlayer />);
    act(() => audioPlaybackService.play(first));
    const region = screen.getByRole('region', { name: 'Now playing' });
    const toggle = screen.getByRole('button', { name: 'Pause' });

    fireEvent.pointerDown(toggle, { button: 0, pointerId: 2, clientX: 500, clientY: 700 });
    act(() => {
      fireEvent.pointerMove(window, { pointerId: 2, clientX: -4000, clientY: -4000 });
      fireEvent.pointerUp(window, { pointerId: 2, clientX: -4000, clientY: -4000 });
    });
    expect(region.style.right).toBe(`${window.innerWidth - 400 - 8}px`);
    expect(region.style.bottom).toBe(`${window.innerHeight - 48 - 8}px`);

    return new Promise<void>((resolve) => setTimeout(() => {
      fireEvent.pointerDown(toggle, { button: 0, pointerId: 3, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(window, { pointerId: 3, clientX: 11, clientY: 10 });
      fireEvent.click(toggle);
      expect(audioPlaybackService.getSnapshot().status).toBe('paused');
      resolve();
    }, 0));
  });

  it('starts from the remembered spot', () => {
    localStorage.setItem(MINI_PLAYER_STORAGE_KEY, JSON.stringify({ right: 120, bottom: 300 }));
    render(<MiniPlayer />);
    act(() => audioPlaybackService.play(first));

    const region = screen.getByRole('region', { name: 'Now playing' });
    expect(region.style.right).toBe('120px');
    expect(region.style.bottom).toBe('300px');
  });

  it('lists earlier episodes and switches to one from the queue', () => {
    render(<MiniPlayer />);
    act(() => {
      audioPlaybackService.play(first);
      audioPlaybackService.play(second);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    fireEvent.click(screen.getByRole('button', { name: /^First episode/ }));

    expect(audioPlaybackService.getSnapshot().currentId).toBe(first.src);
  });

  it('opens the episode article from the title', () => {
    const onOpenArticle = vi.fn();
    render(<MiniPlayer onOpenArticle={onOpenArticle} canOpenArticle={() => true} />);
    act(() => audioPlaybackService.play(first));

    fireEvent.click(screen.getByTitle('Open episode'));
    expect(onOpenArticle).toHaveBeenCalledWith('hash-a');
  });
});
