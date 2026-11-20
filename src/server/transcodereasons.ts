// Transcode reasons as people read them. Pure (no server-only, no database), so
// src/test/ui.test.ts can check it, server/playback.ts can count with it and both statistics
// pages can label it.
//
// What is stored in playback_sessions.transcode_reason: Jellyfin and Emby report
// TranscodeReasons as a list of enum names and the adapter keeps the first
// ("VideoCodecNotSupported"); the Plex adapter derives the same tokens from the stream
// decisions, unless Plex itself sends a reason. Older rows and other writers can hold a
// joined list ("ContainerNotSupported, AudioCodecNotSupported"), which is why everything is
// split before it is counted — otherwise each combination became its own bar.

export interface ReasonCount {
  label: string;
  value: number;
}

/** One stored value → its single reasons. Separators seen in the wild: comma, semicolon, pipe. */
export function splitReasons(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Counts per single reason from (stored value, sessions) pairs, largest first, ties by name.
 * A session that lists two reasons counts once for each — the chart answers "how often was
 * this a cause", not "how many sessions".
 */
export function tallyReasons(rows: ReasonCount[], limit = 10): ReasonCount[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    for (const reason of new Set(splitReasons(row.label))) {
      totals.set(reason, (totals.get(reason) ?? 0) + row.value);
    }
  }
  return [...totals]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/**
 * "VideoCodecNotSupported" → "Video codec not supported", "HDRNotSupported" → "HDR not
 * supported", "audio_codec" → "Audio codec". For values no translation knows yet: a new
 * server version adds an enum member, and the chart should still read as words.
 */
export function humanizeReason(token: string): string {
  const words = token
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    // Acronyms (HDR, AVC) keep their capitals; ordinary words go lower case.
    .map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()));
  if (!words.length) return token;
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/** Translation key of a known reason, or null when the token cannot be a key. */
export function reasonKey(token: string): string | null {
  return /^[A-Za-z0-9]+$/.test(token) ? `ui2.reason.${token}` : null;
}

/**
 * The label for one reason. `translate` returns the key itself for a missing entry (the
 * app's per-key fallback), which is how an unknown token is recognised and humanized.
 */
export function reasonLabel(token: string, translate: (key: string) => string): string {
  const key = reasonKey(token);
  if (key) {
    const text = translate(key);
    if (text && text !== key) return text;
  }
  return humanizeReason(token);
}
