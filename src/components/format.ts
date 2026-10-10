import type { Translate } from '@/i18n';
import type { LabelledValue } from '@/server/stats';

const WEEKDAY_SHORT = [
  'weekday.mon',
  'weekday.tue',
  'weekday.wed',
  'weekday.thu',
  'weekday.fri',
  'weekday.sat',
  'weekday.sun',
] as const;

const WEEKDAY_LONG = [
  'weekday.monday',
  'weekday.tuesday',
  'weekday.wednesday',
  'weekday.thursday',
  'weekday.friday',
  'weekday.saturday',
  'weekday.sunday',
] as const;

/**
 * The server labels its weekday series in English ("Mon"…"Sun", Monday first). The position
 * is the only thing it really says, so the label is rebuilt from that — the same words the
 * week × hour grid uses, which keeps two charts on one page from disagreeing.
 */
export function localizeWeekdays(data: LabelledValue[], t: Translate): LabelledValue[] {
  return data.map((d, index) => ({
    ...d,
    label: index < WEEKDAY_SHORT.length ? t(WEEKDAY_SHORT[index]) : d.label,
  }));
}

/**
 * "12 movies · 340 episodes · 80 music & audiobooks · 3 other" — only the parts that are there,
 * so a video-only server reads as before and the parts always add up to the total.
 */
export function mediaSplit(
  t: Translate,
  counts: { movies?: number; shows?: number; episodes?: number; audio?: number; total?: number },
): string {
  const known = (counts.movies ?? 0) + (counts.shows ?? 0) + (counts.episodes ?? 0) + (counts.audio ?? 0);
  const other = counts.total !== undefined ? Math.max(0, counts.total - known) : 0;
  return [
    counts.movies ? t('split.movies', { count: counts.movies }) : null,
    counts.shows ? t('split.shows', { count: counts.shows }) : null,
    counts.episodes ? t('split.episodes', { count: counts.episodes }) : null,
    counts.audio ? t('split.audio', { count: counts.audio }) : null,
    other ? t('split.other', { count: other }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Full weekday name for a Monday-first index, for use inside a sentence. */
export function weekdayName(index: number, t: Translate): string {
  return t(WEEKDAY_LONG[index] ?? WEEKDAY_LONG[0]);
}

/**
 * Month labels for the twelve buckets the server returns in English. The month names come
 * from the platform: unlike weekdays, no screen shows them anywhere else to stay in step with.
 */
export function localizeMonths(data: LabelledValue[], locale: string): LabelledValue[] {
  const month = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  return data.map((d, index) => ({ ...d, label: month.format(new Date(Date.UTC(2024, index, 1))) }));
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatMinutes(minutes: number): string {
  return formatDuration(minutes * 60000);
}

export function formatDate(value: Date | string): string {
  return new Date(value).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Local YYYY-MM-DD. toISOString() would answer in UTC, and the day filter compares against
 * SQLite's 'localtime' — a play at 00:30 would then link to the wrong day.
 */
export function isoDay(value: Date | string): string {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Next hands over `string | string[]` for a repeated key (`?by=a&by=b`); the first value wins. */
export function firstParam(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * A query-string integer within [min, max], else the fallback. Number() alone lets `abc`,
 * `-1` and `1.5` through, and a NaN or fractional OFFSET makes SQLite throw a 500.
 */
export function intParam(
  raw: string | string[] | undefined,
  fallback: number,
  min = 1,
  max = 1_000_000,
): number {
  const value = Number(firstParam(raw));
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

// Clamped: a server can report a position past the runtime, and the scrub head would leave its track.
export function percent(part: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, Math.round((part / total) * 100))) : 0;
}

/**
 * Artwork always goes through the proxy, so a media server token never reaches the
 * browser. The slug picks the server; an item from a different one simply has no poster.
 */
export const artUrl = (serverSlug: string, itemId: string) =>
  `/api/art/${serverSlug}/${encodeURIComponent(itemId)}`;

/**
 * Rough, human relative time — exact seconds do not matter anywhere this is used. Takes
 * the translator rather than importing one, so it stays usable on both sides of the
 * client boundary like the rest of this file.
 */
export function formatTimeAgo(t: Translate, date: Date | string): string {
  const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60000);
  if (minutes < 1) return t('beam.justNow');
  if (minutes < 60) return t('beam.minutesAgo', { count: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 24
    ? t('beam.hoursAgo', { count: hours })
    : t('beam.daysAgo', { count: Math.round(hours / 24) });
}

/** Film style timecode: HH:MM:SS. Used wherever a playback position is shown. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}
