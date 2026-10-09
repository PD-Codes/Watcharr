// Pure slide logic for the wrapped story. No server-only import, so the test can load it.

export interface StoryTitle {
  label: string;
  plays: number;
  minutes: number;
  /** Proxy URL for the artwork; null renders a typographic slide instead. */
  poster: string | null;
}

/** Everything the story is built from; plain data so it can cross the client boundary. */
export interface StoryInput {
  year: number;
  name: string;
  plays: number;
  watchtimeMs: number;
  distinctTitles: number;
  longestStreak: number;
  topTitle: StoryTitle | null;
  topShow: StoryTitle | null;
  topMovie: StoryTitle | null;
  topGenre: { label: string; share: number } | null;
  /** Local YYYY-MM-DD and the minutes watched on it. */
  busiestDay: { day: string; minutes: number } | null;
  /** Minutes per weekday, Monday first (the order getWrapped returns). */
  weekdayMinutes: number[];
  /** Plays per local hour of day, index 0..23. */
  hourPlays: number[];
}

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';

export type Slide =
  | { kind: 'intro'; year: number; name: string }
  | { kind: 'time'; value: number; unit: 'hours' | 'minutes'; days: number | null }
  | { kind: 'plays'; plays: number; titles: number }
  | ({ kind: 'top' } & StoryTitle)
  | { kind: 'versus'; show: StoryTitle; movie: StoryTitle }
  | { kind: 'genre'; label: string; share: number }
  | {
      kind: 'days';
      busiest: { day: string; minutes: number } | null;
      streak: number | null;
    }
  | { kind: 'when'; hour: number; weekday: number; part: DayPart; hours: number[] }
  | { kind: 'outro'; year: number };

export type SlideKind = Slide['kind'];

const MIN_YEAR = 1970;

/**
 * A query-string year: an integer in a sane range, else the current year. Number() alone
 * lets `abc`, `1.5` and `99999` through, and the value ends up in SQL and a file name.
 */
export function parseYear(raw: string | string[] | null | undefined, now = new Date()): number {
  const current = now.getFullYear();
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (typeof text !== 'string' || !/^\d{4}$/.test(text)) return current;
  const value = Number(text);
  return value >= MIN_YEAR && value <= current + 1 ? value : current;
}

export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/** Index of the largest value, the first one on a tie; -1 when nothing is above zero. */
function peak(values: number[]): number {
  let best = -1;
  let max = 0;
  values.forEach((value, index) => {
    if (value > max) {
      max = value;
      best = index;
    }
  });
  return best;
}

/** Hours when there is at least one, else minutes; null under a minute (nothing to brag about). */
export function watchTime(ms: number): { value: number; unit: 'hours' | 'minutes' } | null {
  if (ms < 60_000) return null;
  const hours = Math.round(ms / 3_600_000);
  return hours >= 1
    ? { value: hours, unit: 'hours' }
    : { value: Math.max(1, Math.round(ms / 60_000)), unit: 'minutes' };
}

/**
 * The slides a year earns, in playback order. A slide only exists when its data does: a
 * year with only movies has no show-versus-movie slide, a year with no durations no time
 * slide. No plays at all means no story (the page shows an empty state instead).
 */
export function buildSlides(input: StoryInput): Slide[] {
  if (input.plays <= 0) return [];

  const slides: Slide[] = [{ kind: 'intro', year: input.year, name: input.name }];

  const time = watchTime(input.watchtimeMs);
  if (time) {
    const days = time.unit === 'hours' ? Math.round(time.value / 24) : 0;
    slides.push({ kind: 'time', ...time, days: days >= 2 ? days : null });
  }

  slides.push({ kind: 'plays', plays: input.plays, titles: input.distinctTitles });

  if (input.topTitle) slides.push({ kind: 'top', ...input.topTitle });
  if (input.topShow && input.topMovie) {
    slides.push({ kind: 'versus', show: input.topShow, movie: input.topMovie });
  }
  if (input.topGenre && input.topGenre.share > 0) {
    slides.push({ kind: 'genre', ...input.topGenre });
  }

  const busiest = input.busiestDay && input.busiestDay.minutes > 0 ? input.busiestDay : null;
  const streak = input.longestStreak >= 2 ? input.longestStreak : null;
  if (busiest || streak) slides.push({ kind: 'days', busiest, streak });

  const hour = peak(input.hourPlays);
  const weekday = peak(input.weekdayMinutes);
  if (hour >= 0 && weekday >= 0) {
    slides.push({
      kind: 'when',
      hour,
      weekday,
      part: dayPart(hour),
      hours: input.hourPlays.slice(0, 24),
    });
  }

  slides.push({ kind: 'outro', year: input.year });
  return slides;
}

/**
 * Text for the share card: Latin letters, digits, punctuation and spaces only, at most `max`
 * characters. The card renderer ships one Latin font; for anything else it downloads fonts
 * (and emoji) from the internet at render time, which leaks the text and fails offline.
 */
export function cardText(value: string, max = 60): string {
  const safe = value
    .normalize('NFC')
    .replace(/[^\p{Script=Latin}\p{Nd}\p{P}\p{Zs}+&$%=]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!safe) return '\u2014';
  const chars = Array.from(safe);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}\u2026` : safe;
}
