// Pure list building for the command palette: grouping, ordering, recents. No DOM, no React.

import type { IconName } from './Icons';
import { fuzzyMatch } from './fuzzy';
import type { Command } from './shortcuts-core';

export type RowGroup = 'recent' | 'actions' | 'pages' | 'results';
export type RecentKind = 'page' | 'title' | 'library' | 'user';

/** What gets remembered about an opened row. */
export interface RecentEntry {
  href: string;
  label: string;
  sub?: string;
  kind: RecentKind;
}

/** A row as the component describes it, before matching. */
export interface Candidate {
  id: string;
  label: string;
  icon: IconName;
  sub?: string;
  /** Extra words that make the row findable ("dark" finds "Switch theme"). */
  keywords?: string;
  tag?: string;
  keys?: string[];
  href?: string;
  command?: Command;
  recent?: RecentEntry;
}

export interface Row extends Candidate {
  group: RowGroup;
  score: number;
  /** Matched positions in `label`, for highlighting. */
  hit?: number[];
}

export interface Section {
  group: RowGroup;
  rows: Row[];
}

export interface Pools {
  recent: Candidate[];
  actions: Candidate[];
  pages: Candidate[];
  results: Candidate[];
}

// A keyword match is weaker evidence than a label match.
const KEYWORD_WEIGHT = 0.5;
// The server already matched these with LIKE, so a row it returns is never "no match".
const SERVER_FLOOR = 8;
const TIE_ORDER: RowGroup[] = ['pages', 'actions', 'results'];

function match(term: string, c: Candidate, group: RowGroup): Row | null {
  const byLabel = fuzzyMatch(term, c.label);
  if (byLabel) return { ...c, group, score: byLabel.score, hit: byLabel.indices };
  const byWords = c.keywords ? fuzzyMatch(term, c.keywords) : null;
  return byWords ? { ...c, group, score: byWords.score * KEYWORD_WEIGHT } : null;
}

/**
 * Empty query: Recent, then Actions, then Pages, each in its given order.
 * With a query: Pages and Actions are fuzzy-filtered and sorted, Results keep the server's
 * order (it sorts by recency), and the groups are ordered by their best row, so typing
 * "sess" puts Sessions on top while typing a title puts the title on top.
 */
export function buildSections(query: string, pools: Pools): Section[] {
  const term = query.trim();
  const plain = (rows: Candidate[], group: RowGroup): Row[] =>
    rows.map((c) => ({ ...c, group, score: 0 }));

  if (!term) {
    return (
      [
        { group: 'recent', rows: plain(pools.recent, 'recent') },
        { group: 'actions', rows: plain(pools.actions, 'actions') },
        { group: 'pages', rows: plain(pools.pages, 'pages') },
      ] as Section[]
    ).filter((s) => s.rows.length > 0);
  }

  const ranked = (rows: Candidate[], group: RowGroup) =>
    rows
      .map((c, i) => ({ row: match(term, c, group), i }))
      .filter((x): x is { row: Row; i: number } => x.row !== null)
      .sort((a, b) => b.row.score - a.row.score || a.i - b.i)
      .map((x) => x.row);

  const results: Row[] = pools.results.map((c) => {
    const hit = fuzzyMatch(term, c.label);
    return { ...c, group: 'results', score: Math.max(hit?.score ?? 0, SERVER_FLOOR), hit: hit?.indices };
  });

  const sections: Section[] = [
    { group: 'pages', rows: ranked(pools.pages, 'pages') },
    { group: 'actions', rows: ranked(pools.actions, 'actions') },
    { group: 'results', rows: results },
  ];

  return sections
    .filter((s) => s.rows.length > 0)
    .sort((a, b) => {
      const top = (s: Section) => Math.max(...s.rows.map((r) => r.score));
      return top(b) - top(a) || TIE_ORDER.indexOf(a.group) - TIE_ORDER.indexOf(b.group);
    });
}

export const flatten = (sections: Section[]): Row[] => sections.flatMap((s) => s.rows);

// --- Recents ---------------------------------------------------------------------------

export const RECENT_MAX = 5;
const KINDS: RecentKind[] = ['page', 'title', 'library', 'user'];

// A same-origin path only: the stored href goes straight into router.push, and storage can
// be edited by anything running on this origin.
// No `//host`, no `/\host` (browsers read a backslash as a slash), no control chars or spaces.
const isLocalPath = (href: string) => /^\/(?![/\\])[^\x00-\x20]*$/.test(href);

/** Tolerant reader: anything that is not a well-formed entry is dropped, never thrown on. */
export function parseRecent(raw: string | null | undefined): RecentEntry[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const out: RecentEntry[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const { href, label, sub, kind } = item as Record<string, unknown>;
    if (typeof href !== 'string' || !isLocalPath(href)) continue;
    if (typeof label !== 'string' || !label) continue;
    if (!KINDS.includes(kind as RecentKind)) continue;
    if (out.some((e) => e.href === href)) continue;
    out.push({ href, label, kind: kind as RecentKind, ...(typeof sub === 'string' ? { sub } : {}) });
    if (out.length === RECENT_MAX) break;
  }
  return out;
}

/** Newest first, one entry per href, capped. */
export function pushRecent(list: RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return [entry, ...list.filter((e) => e.href !== entry.href)].slice(0, RECENT_MAX);
}
