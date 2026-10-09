'use client';

import { useEffect, useState } from 'react';
import { formatTimecode, percent } from './format';

/**
 * The server only learns a playback position every few seconds, so a bar fed straight from
 * it jumps. These keep a playing stream moving between refreshes: the position the server
 * reported, plus the time that passed since. Paused streams stand still, and every refresh
 * replaces the guess with the real value.
 */
function useLivePosition(progressMs: number, durationMs: number, playing: boolean, ageMs: number) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!playing) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, [progressMs, playing]);
  const raw = progressMs + (playing ? ageMs + elapsed : 0);
  return durationMs > 0 ? Math.min(raw, durationMs) : raw;
}

type Props = { progressMs: number; durationMs: number; playing: boolean; ageMs: number };

/** The scrub line of the Now Playing beam. */
export function LiveScrub({ tip, ...props }: Props & { tip: string }) {
  const position = useLivePosition(props.progressMs, props.durationMs, props.playing, props.ageMs);
  const progress = percent(position, props.durationMs);
  return (
    <div className="scrub" data-tip={tip}>
      <span className="scrub-fill" style={{ width: `${progress}%` }} />
      <span className="scrub-head" style={{ left: `${progress}%` }} />
    </div>
  );
}

/** "00:12:03 / 00:45:00" that keeps counting. */
export function LiveTimecode(props: Props) {
  const position = useLivePosition(props.progressMs, props.durationMs, props.playing, props.ageMs);
  return (
    <span className="timecode num">
      {formatTimecode(position)} / {formatTimecode(props.durationMs)}
    </span>
  );
}

/** The thin bar inside table rows. */
export function LiveBar({ tip, ...props }: Props & { tip: string }) {
  const position = useLivePosition(props.progressMs, props.durationMs, props.playing, props.ageMs);
  return (
    <div className="progress" data-tip={tip}>
      <span style={{ width: `${percent(position, props.durationMs)}%` }} />
    </div>
  );
}
