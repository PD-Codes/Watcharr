/**
 * The pure logic behind /screen, the lobby display. No `server-only` and no database, so the
 * test script can import it and the client component can share the types.
 *
 * Everything time-dependent takes `now` as an argument instead of reading the clock: the
 * display runs for weeks, and a rule that cannot be fed a date cannot be tested for the
 * moment it matters (ten minutes in, the middle of a cycle, a stream that just paused).
 */

/**
 * The longest a position is carried forward from what the server last reported. Long
 * enough for a client that only reports every minute, short of the four minutes after
 * which the app itself treats a frozen stream as gone.
 */
export const MAX_EXTRAPOLATION_MS = 90_000;
/** A running client clock this close to a fresh server value is kept, so time never ticks backwards. */
export const CLOCK_TOLERANCE_MS = 3_000;
/** One lap of the burn-in drift, and how far it strays from the center. */
export const DRIFT_CYCLE_MS = 90_000;
export const DRIFT_MAX_PX = 6;
/** Without a stream for this long the display dims, over DIM_RAMP_MS, to DIM_LEVEL. */
export const DIM_AFTER_MS = 10 * 60_000;
export const DIM_RAMP_MS = 30_000;
export const DIM_LEVEL = 0.7;
/** How long one poster of the intermission loop stays on screen. */
export const SLIDE_MS = 8_000;

const DAY_MS = 86_400_000;

export interface ScreenStream {
  key: string;
  itemId: string;
  /** The show for an episode, otherwise the title itself. */
  title: string;
  /** The episode's own title; null for a film. */
  episode: string | null;
  state: 'playing' | 'paused' | 'buffering';
  durationMs: number;
  /** Where the playhead is at the moment the page was rendered. */
  positionMs: number;
  /** Playing and recently heard from: only then does the playhead keep moving on its own. */
  advancing: boolean;
  startedAt: number;
  /** Only ever set for an admin: the dashboard's visibility rule. */
  user: string | null;
  device: string | null;
  client: string | null;
}

export interface ScreenSlide {
  key: string;
  itemId: string;
  /** TMDB poster, used when the media server has no artwork for the item. */
  fallback: string | null;
  title: string;
  year: number | null;
  kind: 'added' | 'watched';
  /** "Added 3 days ago", already phrased by the server. */
  meta: string;
}

export interface ScreenStats {
  plays: number;
  watchMs: number;
  streak: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** A playhead stays on the film: never negative, never past the runtime (when it is known). */
function clampPosition(positionMs: number, durationMs: number): number {
  const floor = Math.max(0, positionMs);
  return durationMs > 0 ? Math.min(floor, durationMs) : floor;
}

const STATE_RANK: Record<string, number> = { playing: 0, buffering: 1 };

/**
 * Hero first. A stream that is actually running outranks a paused one (the lights come up
 * on a pause, it is not the show), and among equals the newest start wins, so the stage
 * only changes hands when somebody starts something, never back and forth between two
 * long-running streams. The key is the last tie-break, which keeps the order stable
 * between refreshes.
 */
export function orderStreams<T extends { key: string; state: string; startedAt: number }>(
  streams: readonly T[],
): T[] {
  const rank = (state: string) => STATE_RANK[state] ?? 2;
  return [...streams].sort(
    (a, b) =>
      rank(a.state) - rank(b.state) || b.startedAt - a.startedAt || a.key.localeCompare(b.key),
  );
}

/**
 * Where a stream is at `now`, as well as the stored row can tell. The row holds the
 * position as of `progressAt` (when it last changed), so a playing stream is carried
 * forward from there. Anchoring on that moment and not on the last poll matters: a client
 * that reports every ten seconds makes the poll see the same stale value twice, and
 * anchoring on the poll would pull the estimate back by a poll interval each time.
 */
export function serverPosition(
  row: { state: string; progressMs: number; durationMs: number; progressAt: number },
  now: number,
): number {
  const carried = row.state === 'playing' ? clamp(now - row.progressAt, 0, MAX_EXTRAPOLATION_MS) : 0;
  return clampPosition(row.progressMs + carried, row.durationMs);
}

/**
 * Whether the playhead should keep running by itself. A stream whose position has not
 * moved for longer than the extrapolation allows is frozen on screen at the capped value,
 * so a dead client does not make the timecode run on until the app drops the session.
 */
export function isAdvancing(row: { state: string; progressAt: number }, now: number): boolean {
  return row.state === 'playing' && now - row.progressAt <= MAX_EXTRAPOLATION_MS;
}

/** A playhead pinned to the wall clock: `positionMs` was true at time `at`. */
export interface StreamClock {
  positionMs: number;
  at: number;
  playing: boolean;
  durationMs: number;
}

/** Where the playhead is at `now`. Only a playing stream advances. */
export function positionAt(clock: StreamClock, now: number): number {
  if (!clock.playing) return clock.positionMs;
  return clampPosition(clock.positionMs + Math.max(0, now - clock.at), clock.durationMs);
}

/**
 * Fresh data arrived. A running clock that agrees with it to within the tolerance is kept
 * as it is: adopting the server's value every time would nudge the timecode back by a
 * second now and then, which on a screen read from across the room looks like a glitch.
 * Anything further apart (a seek, a pause, the next episode) is the server's word.
 */
export function reconcileClock(
  prev: StreamClock | undefined,
  next: { positionMs: number; playing: boolean; durationMs: number },
  now: number,
  toleranceMs = CLOCK_TOLERANCE_MS,
): StreamClock {
  if (
    prev &&
    prev.playing &&
    next.playing &&
    prev.durationMs === next.durationMs &&
    Math.abs(positionAt(prev, now) - next.positionMs) <= toleranceMs
  ) {
    return prev;
  }
  return { ...next, at: now };
}

/** Wall-clock time in the app locale: 12 h with a separate AM/PM, or 24 h, as the locale has it. */
export function clockParts(
  ms: number,
  locale: string,
  timeZone?: string,
): { time: string; period: string | null; date: string } {
  const parts = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).formatToParts(ms);
  const period = parts.find((part) => part.type === 'dayPeriod')?.value ?? null;
  const time = parts
    .filter((part) => part.type !== 'dayPeriod')
    .map((part) => part.value)
    .join('')
    .trim();
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone,
  }).format(ms);
  return { time, period, date };
}

/**
 * Burn-in care: the whole layout circles the middle by at most `maxPx` once per cycle, so
 * no edge of the interface sits on the same physical pixels for hours. A circle, not a
 * back-and-forth line, because every edge then crosses fresh pixels in both axes.
 */
export function driftOffset(
  now: number,
  cycleMs = DRIFT_CYCLE_MS,
  maxPx = DRIFT_MAX_PX,
): { x: number; y: number } {
  const phase = ((now % cycleMs) / cycleMs) * Math.PI * 2;
  const round = (value: number) => Math.round(value * 10) / 10 + 0; // + 0 turns -0 into 0
  return { x: round(maxPx * Math.sin(phase)), y: round(maxPx * Math.cos(phase)) };
}

/** Brightness multiplier: 1 while a stream ran recently, easing down to DIM_LEVEL once idle too long. */
export function idleDim(idleSince: number | null, now: number): number {
  if (idleSince === null) return 1;
  const over = now - idleSince - DIM_AFTER_MS;
  if (over <= 0) return 1;
  return Math.round((1 - (1 - DIM_LEVEL) * Math.min(1, over / DIM_RAMP_MS)) * 1000) / 1000;
}

/** The slide after `current`. A list that shrank under the index wraps to the start. */
export function nextSlide(current: number, count: number): number {
  return count > 1 ? (current + 1) % count : 0;
}

/**
 * First `limit` entries with a distinct title. Five episodes of one show are one poster in
 * the loop, not five; compared without case and edge whitespace.
 */
export function uniqueTitles<T extends { title: string }>(items: readonly T[], limit: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = item.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * "today", "yesterday", "3 days ago", "2 weeks ago": Intl phrases it in the locale and
 * knows its plurals, which the app's own strings do not.
 */
export function relativeAge(from: number, now: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const days = Math.max(0, Math.floor((now - from) / DAY_MS));
  if (days < 1) return format.format(0, 'day');
  if (days < 14) return format.format(-days, 'day');
  if (days < 60) return format.format(-Math.floor(days / 7), 'week');
  if (days < 730) return format.format(-Math.floor(days / 30), 'month');
  return format.format(-Math.floor(days / 365), 'year');
}
