import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { newsletterSubscriptions, users } from '@/db/schema';
import type { LibraryItem } from './adapters';
import { publicArtUrl } from './artlink';
import { createAdapter, type ServerType } from './adapters';
import { getSettings, listServers, updateSettings, type ServerRow } from './config';
import { DEFAULT_LOCALE, isLocale, LOCALES, translator, type Locale } from '@/i18n';
import { getDefaultLocale } from '@/i18n/server';
import { sectionKey } from './library';
import { sendMail } from './notifications';
import { buildNewsletterHtml, type MailCard, type MailModel } from './newsletter-html';
import { cachedMeta, getTitleMeta, localizedMeta, type TmdbMeta } from './tmdb';
import { globalState } from './state';

// The recently-added newsletter. Two owners on purpose: a global admin decides the
// schedule, the time frame, the covered libraries and the wording, while every user
// subscribes and unsubscribes themselves from their own profile. An admin can never add
// somebody else's address.

const PER_LIBRARY_LIMIT = 60;

export interface NewsletterEntry {
  serverLabel: string;
  serverSlug: string;
  items: LibraryItem[];
}

/**
 * The saved library selection as `<serverId>:<sectionId>` keys, the shape the notification
 * conditions store. Section ids are only unique within one server (Plex hands out "1", "2"),
 * so a bare id cannot say which server's library it meant. Values saved before keys carried
 * the server are bare ids; they were handed to every server, so they expand to every server
 * and the first save from the admin page replaces them. Nothing is rewritten in place.
 */
export function normalizeLibraries(saved: string[], serverIds: number[]): string[] {
  const keys = new Set<string>();
  for (const value of saved) {
    if (!value) continue;
    if (/^\d+:./.test(value)) keys.add(value);
    else for (const serverId of serverIds) keys.add(sectionKey(serverId, value));
  }
  return [...keys];
}

/**
 * What to ask one server for. An empty selection means every library everywhere; otherwise
 * only the ids that belong to this server, and none of them means the admin left this
 * server out entirely (null) rather than "everything" — an empty list passed on would do
 * exactly that.
 */
export function sectionsForServer(selection: string[], serverId: number): string[] | null {
  if (selection.length === 0) return [];
  const own = selection
    .filter((key) => key.startsWith(`${serverId}:`))
    .map((key) => key.slice(String(serverId).length + 1));
  return own.length ? own : null;
}

async function collectForServer(
  server: ServerRow,
  sectionIds: string[],
  since: Date,
): Promise<LibraryItem[]> {
  const adapter = createAdapter(
    server.serverType as ServerType,
    server.serverUrl,
    server.serverToken,
  );

  // No configured sections means "everything the server reports", which is also what a
  // fresh install does before anyone has opened the settings page.
  const sources = sectionIds.length ? sectionIds : [undefined];
  const batches = await Promise.all(
    sources.map((sectionId) =>
      adapter.getRecentlyAdded(PER_LIBRARY_LIMIT, sectionId).catch(() => [] as LibraryItem[]),
    ),
  );

  const seen = new Set<string>();
  return batches
    .flat()
    .filter((item) => {
      // Servers that do not report an added date are kept: dropping them would make the
      // newsletter silently empty rather than merely imprecise.
      if (item.addedAt && item.addedAt < since) return false;
      if (seen.has(item.itemId)) return false;
      seen.add(item.itemId);
      return true;
    })
    .sort((a, b) => (b.addedAt?.getTime() ?? 0) - (a.addedAt?.getTime() ?? 0));
}

/** Unsaved form values the admin preview renders with instead of the stored settings. */
export interface NewsletterDraft {
  days?: number;
  libraries?: string[];
  subject?: string;
  intro?: string;
}

/** What arrived in the configured window, grouped per server. */
export async function collectNewsletter(draft: NewsletterDraft = {}): Promise<NewsletterEntry[]> {
  const settings = await getSettings();
  const since = new Date(Date.now() - (draft.days ?? settings.newsletterDays) * 86_400_000);
  const servers = await listServers();
  const selection = normalizeLibraries(
    draft.libraries ?? settings.newsletterLibraries,
    servers.map((server) => server.id),
  );

  const entries = await Promise.all(
    servers.map(async (server) => {
      const sectionIds = sectionsForServer(selection, server.id);
      return {
        serverLabel: server.label,
        serverSlug: server.slug,
        items: sectionIds ? await collectForServer(server, sectionIds, since) : [],
      };
    }),
  );
  return entries.filter((entry) => entry.items.length > 0);
}

// Titles looked up on TMDB for a fresh issue; the rest read the cache only. A weekly job can
// afford a few dozen requests, a preview click should not wait on hundreds.
const ENRICH_LIMIT = 14;
const HIGHLIGHTS = 5;
const GRID_PER_SERVER = 24;
const POPULAR_LIMIT = 5;

const kindOf = (mediaType: string): 'movie' | 'series' => (mediaType === 'movie' ? 'movie' : 'series');

/** Folds episodes of one show (Plex lists them one by one) into a single card per server. */
function toCards(entries: NewsletterEntry[], appUrl: string | undefined) {
  const cards = new Map<string, MailCard & { server: string; slug: string; itemId: string }>();
  for (const entry of entries) {
    for (const item of entry.items) {
      const kind = kindOf(item.mediaType);
      const key = `${entry.serverSlug}|${kind}|${item.title.toLowerCase()}|${kind === 'movie' ? (item.year ?? '') : ''}`;
      const isEpisode = item.mediaType === 'episode';
      const known = cards.get(key);
      if (known) {
        if (isEpisode) known.episodes += 1;
        continue;
      }
      cards.set(key, {
        title: item.title,
        year: item.year,
        kind,
        episodes: isEpisode ? 1 : 0,
        genres: item.genres,
        addedAt: item.addedAt,
        poster: publicArtUrl(entry.serverSlug, item.itemId) ?? undefined,
        href: appUrl ? `${appUrl}/title/${encodeURIComponent(item.title)}` : undefined,
        server: entry.serverLabel,
        slug: entry.serverSlug,
        itemId: item.itemId,
      });
    }
  }
  return [...cards.values()].sort((a, b) => (b.addedAt?.getTime() ?? 0) - (a.addedAt?.getTime() ?? 0));
}

function applyMeta(card: MailCard, raw: TmdbMeta | null | undefined, locale: Locale) {
  const meta = localizedMeta(raw, locale);
  if (!meta) return;
  // TMDB images are public, so they reach every mail client; the signed media-server link only
  // works while APP_URL is reachable from outside.
  card.poster = meta.posterUrl ?? card.poster;
  card.backdrop = meta.backdropUrl;
  card.rating = meta.voteAverage && meta.voteCount && meta.voteCount >= 20 ? meta.voteAverage : undefined;
  card.runtimeMinutes = meta.runtimeMinutes || undefined;
  card.tagline = meta.tagline;
  card.overview = meta.overview;
  if (!card.genres.length) card.genres = meta.genres;
}

/** The titles watched most inside the period — counts only, never who watched. */
async function mostWatched(since: Date) {
  const rows = await db.all<{ label: string; plays: number }>(sql`
    SELECT coalesce(grandparent_title, title) AS label, count(*) AS plays
    FROM watch_history
    WHERE watched_at >= ${since.getTime()} AND duration_ms >= 60000
    GROUP BY label
    ORDER BY plays DESC, label
    LIMIT ${POPULAR_LIMIT}`);
  return rows.filter((row) => row.plays >= 2);
}

/**
 * Renders one issue: a pick of the issue, highlights with synopsis, what was watched most,
 * and the remaining arrivals as a poster grid per server.
 */
export async function renderNewsletter(
  entries: NewsletterEntry[],
  locale: Locale = DEFAULT_LOCALE,
  draft: NewsletterDraft = {},
): Promise<string> {
  const settings = await getSettings();
  const days = draft.days ?? settings.newsletterDays;
  const appUrl = process.env.APP_URL?.trim().replace(/\/$/, '') || undefined;
  const cards = toCards(entries, appUrl);

  // Metadata for the newest titles is fetched (and cached); the rest only reads the cache.
  const apiKey = settings.tmdbApiKey;
  const head = cards.slice(0, ENRICH_LIMIT);
  const asRef = (c: (typeof cards)[number]) => ({ itemId: c.itemId, title: c.title, mediaType: c.kind === 'movie' ? 'movie' : 'show', year: c.year });
  const fetched = await Promise.all(
    head.map((c) => getTitleMeta(apiKey, c.title, c.kind === 'movie' ? 'movie' : 'show', c.year, locale).catch(() => null)),
  );
  head.forEach((c, i) => applyMeta(c, fetched[i], locale));
  const rest = cards.slice(ENRICH_LIMIT);
  const cached = await cachedMeta(rest.map(asRef));
  for (const c of rest) applyMeta(c, cached.get(c.itemId), locale);

  // The pick is the best-rated of the newest titles that has a wide image; without ratings
  // (no TMDB key) it is simply the newest one.
  const candidates = head.filter((c) => c.backdrop || c.poster);
  const hero =
    [...candidates].sort((a, b) => (b.backdrop ? 1 : 0) - (a.backdrop ? 1 : 0) || (b.rating ?? 0) - (a.rating ?? 0))[0] ??
    cards[0];
  const others = cards.filter((c) => c !== hero);
  const highlights = others.slice(0, HIGHLIGHTS);
  const grid = others.slice(HIGHLIGHTS);

  const sections = entries
    .map((entry) => {
      const own = grid.filter((c) => c.slug === entry.serverSlug);
      return { server: entry.serverLabel, cards: own.slice(0, GRID_PER_SERVER), hidden: Math.max(0, own.length - GRID_PER_SERVER) };
    })
    .filter((s) => s.cards.length > 0);

  const genreCount = new Map<string, number>();
  for (const c of cards) for (const g of c.genres) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
  const topGenres = [...genreCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);

  const popularRows = cards.length || entries.length ? await mostWatched(new Date(Date.now() - days * 86_400_000)) : [];
  const popularMeta = await cachedMeta(popularRows.map((r) => ({ itemId: r.label, title: r.label, mediaType: 'show' })));
  const popularMovieMeta = await cachedMeta(popularRows.map((r) => ({ itemId: r.label, title: r.label, mediaType: 'movie' })));

  const model: MailModel = {
    subject: draft.subject ?? settings.newsletterSubject,
    intro: (draft.intro ?? settings.newsletterIntro).trim(),
    days,
    stats: {
      movies: cards.filter((c) => c.kind === 'movie').length,
      series: cards.filter((c) => c.kind === 'series').length,
      episodes: cards.reduce((sum, c) => sum + c.episodes, 0),
    },
    topGenres,
    hero,
    highlights,
    sections,
    popular: popularRows.map((r) => ({
      title: r.label,
      plays: r.plays,
      poster: (popularMeta.get(r.label) ?? popularMovieMeta.get(r.label))?.posterUrl,
      href: appUrl ? `${appUrl}/title/${encodeURIComponent(r.label)}` : undefined,
    })),
    openUrl: appUrl,
  };
  return buildNewsletterHtml(model, translator(locale), locale);
}

/** Everyone who asked for it. */
export async function listSubscribers(): Promise<
  { userId: number; username: string; email: string; locale: string | null }[]
> {
  return db
    .select({
      userId: newsletterSubscriptions.userId,
      username: users.username,
      email: newsletterSubscriptions.email,
      locale: users.locale,
    })
    .from(newsletterSubscriptions)
    .innerJoin(users, eq(users.id, newsletterSubscriptions.userId));
}

/** How many subscribers each language would get — what the preview offers to switch between. */
export async function subscriberLocales(): Promise<Record<string, number>> {
  const fallback = await getDefaultLocale();
  const counts: Record<string, number> = {};
  for (const s of await listSubscribers()) {
    const locale = isLocale(s.locale) ? s.locale : fallback;
    counts[locale] = (counts[locale] ?? 0) + 1;
  }
  return counts;
}

export async function getSubscription(userId: number): Promise<{ email: string } | null> {
  const [row] = await db
    .select({ email: newsletterSubscriptions.email })
    .from(newsletterSubscriptions)
    .where(eq(newsletterSubscriptions.userId, userId));
  return row ?? null;
}

export async function subscribe(userId: number, email: string): Promise<void> {
  await db
    .insert(newsletterSubscriptions)
    .values({ userId, email })
    .onConflictDoUpdate({ target: newsletterSubscriptions.userId, set: { email } });
}

export async function unsubscribe(userId: number): Promise<void> {
  await db.delete(newsletterSubscriptions).where(eq(newsletterSubscriptions.userId, userId));
}

/**
 * Builds and sends one issue to every subscriber, and keeps the rendered HTML so the
 * static URL can serve exactly what was sent rather than rebuilding it later from a
 * library that has moved on.
 */
export async function sendNewsletter(): Promise<{ ok: boolean; sent: number; error?: string }> {
  const settings = await getSettings();
  const subscribers = await listSubscribers();
  const entries = await collectNewsletter();
  const fallback = await getDefaultLocale();

  // Rendered once per language actually subscribed to, not once per subscriber: the issue
  // is identical apart from three sentences, and a deployment realistically has one or two
  // languages in play. Recipients stay in BCC per group, so nobody learns another's address.
  const byLocale = new Map<Locale, string[]>();
  for (const subscriber of subscribers) {
    const locale = isLocale(subscriber.locale) ? subscriber.locale : fallback;
    byLocale.set(locale, [...(byLocale.get(locale) ?? []), subscriber.email]);
  }

  // The static URL is read by whoever opens it, so every app language is kept (two today);
  // the deployment's own language stays the plain column, for readers of an unknown one.
  const rendered: Record<string, string> = {};
  for (const locale of LOCALES) rendered[locale] = await renderNewsletter(entries, locale);
  const stored = rendered[fallback];
  await updateSettings({
    newsletterLastHtml: stored,
    newsletterLastHtmlByLocale: rendered,
    newsletterLastSentAt: new Date(),
  });
  if (!subscribers.length) return { ok: true, sent: 0 };

  let error: string | undefined;
  for (const [locale, recipients] of byLocale) {
    const html = rendered[locale] ?? stored;
    const result = await sendMail(recipients, settings.newsletterSubject, html);
    // One broken group must not hide that the others went out.
    if (!result.ok) error ??= result.error;
  }
  return error ? { ok: false, sent: 0, error } : { ok: true, sent: subscribers.length };
}

const sending = globalState('newsletter', () => ({ busy: false }));

/** Weekly-or-daily schedule check, run from the activity sync tick like every other timer. */
export async function checkNewsletter() {
  const settings = await getSettings();
  if (!settings.newsletterEnabled) return;

  const now = new Date();
  if (now.getDay() !== settings.newsletterDayOfWeek || now.getHours() !== settings.newsletterHour) {
    return;
  }
  // The hour window is checked on every poll, so without this it would send once per poll
  // for a whole hour. Six days is far enough back to allow a weekly cadence to fire again.
  const last = settings.newsletterLastSentAt?.getTime() ?? 0;
  if (Date.now() - last < 6 * 86_400_000) return;

  // The stamp above is only written after the library fetch inside sendNewsletter(), and
  // sync passes overlap (page renders, the 30 s tick, socket frames) — each would pass the
  // check while the first is still collecting and mail the issue again. Process-wide (see
  // state.ts), not per module graph.
  if (sending.busy) return;
  sending.busy = true;
  try {
    const result = await sendNewsletter();
    // The 6-day lock is already set at this point, so a failed delivery would otherwise vanish
    // until the next scheduled slot with nothing in the log.
    if (!result.ok) console.warn(`[watcharr] scheduled newsletter failed: ${result.error}`);
  } finally {
    sending.busy = false;
  }
}
