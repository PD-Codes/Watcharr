import type { Translate } from '@/i18n';

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

export function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
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
