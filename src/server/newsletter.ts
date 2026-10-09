import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { newsletterSubscriptions, users } from '@/db/schema';
import type { LibraryItem } from './adapters';
import { publicArtUrl } from './artlink';
import { createAdapter, type ServerType } from './adapters';
import { getSettings, listServers, updateSettings, type ServerRow } from './config';
import { DEFAULT_LOCALE, isLocale, translator, type Locale } from '@/i18n';
import { getDefaultLocale } from '@/i18n/server';
import { sectionKey } from './library';
import { sendMail } from './notifications';
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

/** Escapes text that goes into the rendered HTML — titles come from the media server. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

/** What arrived in the configured window, grouped per server. */
export async function collectNewsletter(): Promise<NewsletterEntry[]> {
  const settings = await getSettings();
  const since = new Date(Date.now() - settings.newsletterDays * 86_400_000);
  const servers = await listServers();
  const selection = normalizeLibraries(
    settings.newsletterLibraries,
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

/**
 * Renders one issue. Table-based and inline-styled on purpose: mail clients ignore most of
 * a stylesheet, and this has to survive Gmail as well as it survives the static URL.
 */
export async function renderNewsletter(
  entries: NewsletterEntry[],
  locale: Locale = DEFAULT_LOCALE,
): Promise<string> {
  const settings = await getSettings();
  const t = translator(locale);
  const intro = settings.newsletterIntro.trim();

  const sections = entries
    .map((entry) => {
      const cards = entry.items
        .map((item) => {
          const poster = publicArtUrl(entry.serverSlug, item.itemId);
          const year = item.year ? ` (${item.year})` : '';
          return `
            <td style="padding:8px;vertical-align:top;width:150px">
              ${
                poster
                  ? `<img src="${escapeHtml(poster)}" alt="" width="140" style="border-radius:8px;display:block">`
                  : ''
              }
              <p style="margin:8px 0 0;font-size:13px;color:#e9e6e1">${escapeHtml(item.title)}${year}</p>
              <p style="margin:2px 0 0;font-size:11px;color:#9b958c">${escapeHtml(item.mediaType)}</p>
            </td>`;
        })
        .join('');

      // Four per row keeps the table inside a phone's mail view.
      const rows: string[] = [];
      const cells = cards.split('</td>').filter((c) => c.trim());
      for (let i = 0; i < cells.length; i += 4) {
        rows.push(`<tr>${cells.slice(i, i + 4).join('</td>')}</td></tr>`);
      }

      return `
        <h2 style="font-size:16px;color:#e9e6e1;margin:28px 0 6px">${escapeHtml(entry.serverLabel)}</h2>
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows.join('')}</table>`;
    })
    .join('');

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#131211;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <div style="max-width:640px;margin:0 auto">
    <h1 style="font-size:20px;color:#ffb020;margin:0 0 4px">${escapeHtml(settings.newsletterSubject)}</h1>
    <p style="font-size:12px;color:#9b958c;margin:0">
      ${escapeHtml(t('newsletterMail.period', { days: settings.newsletterDays }))}
    </p>
    ${intro ? `<p style="font-size:13px;color:#e9e6e1;margin:16px 0 0">${escapeHtml(intro)}</p>` : ''}
    ${sections || `<p style="color:#9b958c;font-size:13px;margin-top:20px">${escapeHtml(t('newsletterMail.nothing'))}</p>`}
    <p style="font-size:11px;color:#6f6a63;margin-top:32px">
      ${escapeHtml(t('newsletterMail.footer'))}
    </p>
  </div>
</body></html>`;
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

  // The static URL serves the deployment's own language: it is one stored issue, and the
  // person opening it is not necessarily one of the recipients.
  const stored = await renderNewsletter(entries, fallback);
  await updateSettings({ newsletterLastHtml: stored, newsletterLastSentAt: new Date() });
  if (!subscribers.length) return { ok: true, sent: 0 };

  let error: string | undefined;
  for (const [locale, recipients] of byLocale) {
    const html = locale === fallback ? stored : await renderNewsletter(entries, locale);
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
