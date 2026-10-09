// Small subsequence matcher for the command palette. Pure: no DOM, no React.

export interface FuzzyHit {
  /** Higher is better. Only comparable between hits for the same query. */
  score: number;
  /** Positions in the original text that matched, ascending. Used for highlighting. */
  indices: number[];
}

const PREFIX = 10;
const WORD_START = 7;
const CAMEL = 5;
const CONSECUTIVE = 6;
const GAP = 0.8;
const LEADING = 0.15;

// One UTF-16 unit in, one out, so indices into the folded text stay valid for the original:
// "Übersicht" must answer to "ub", and a letter with a combining mark to its base letter.
const fold = (ch: string) => ch.normalize('NFD').charAt(0).toLowerCase();

const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);

function boundaryBonus(text: string, at: number): number {
  if (at === 0) return PREFIX;
  const before = text.charAt(at - 1);
  if (!isWordChar(before)) return WORD_START;
  const here = text.charAt(at);
  return before === before.toLowerCase() && here !== here.toLowerCase() ? CAMEL : 0;
}

/**
 * Matches `query` as a subsequence of `text` and scores the best alignment: prefixes and
 * word starts beat mid-word hits, runs of adjacent characters beat scattered ones, and a
 * shorter text beats a longer one on a tie. Whitespace in the query is ignored, so
 * "all act" finds "All Activity". Returns null when there is no acceptable match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyHit | null {
  const q = Array.from(query.replace(/\s+/g, ''), fold);
  if (q.length === 0) return { score: 0, indices: [] };
  const n = text.length;
  if (q.length > n) return null;

  const folded = Array.from({ length: n }, (_, i) => fold(text.charAt(i)));
  const m = q.length;
  const best: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(-Infinity));
  const from: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(-1));

  // shortcut: O(m * n^2), fine for labels under ~80 chars; use prefix maxima if it ever runs on long text.
  for (let i = 0; i < m; i++) {
    for (let j = i; j < n; j++) {
      if (folded[j] !== q[i]) continue;
      const own = 1 + boundaryBonus(text, j);
      if (i === 0) {
        best[0][j] = own - j * LEADING;
        continue;
      }
      for (let k = i - 1; k < j; k++) {
        const prev = best[i - 1][k];
        if (prev === -Infinity) continue;
        const total = prev + own + (k === j - 1 ? CONSECUTIVE : -GAP * (j - k - 1));
        if (total > best[i][j]) {
          best[i][j] = total;
          from[i][j] = k;
        }
      }
    }
  }

  let end = -1;
  for (let j = m - 1; j < n; j++) if (best[m - 1][j] > (end < 0 ? -Infinity : best[m - 1][end])) end = j;
  if (end < 0) return null;

  const indices = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; j = from[i][j], i--) indices[i] = j;

  // Scattered letters across a long label are noise, not a match: on average each query
  // character has to be worth at least a point after gap penalties.
  const raw = best[m - 1][end];
  if (m >= 3 && raw < m) return null;

  return { score: raw - n * 0.02, indices };
}

/** Splits `text` into alternating plain and matched runs for rendering. */
export function highlightRuns(text: string, indices: readonly number[] | undefined): { text: string; hit: boolean }[] {
  if (!indices || indices.length === 0) return [{ text, hit: false }];
  const marked = new Set(indices);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = marked.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text.charAt(i);
    else runs.push({ text: text.charAt(i), hit });
  }
  return runs;
}
