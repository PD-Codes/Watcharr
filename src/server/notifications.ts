import 'server-only';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { notificationChannels, notificationLog, users } from '@/db/schema';
import { publicArtUrl } from './artlink';
import { getSettings } from './config';
import { decryptSecret, encryptSecret } from './crypto';
import { matchesConditions, renderTemplate, type ChannelType, type NotificationEvent } from './features';
import type { Translate } from '@/i18n';
import { getDefaultT } from '@/i18n/server';

export type { NotificationEvent };

// Every channel below is a JSON or form POST over fetch — no SDK carries its own retry
// queue, auth flow or SMTP stack, so none of this needed a dependency except email, where
// hand-rolling STARTTLS/AUTH correctly is a real security surface. nodemailer is the one
// exception to the zero-dependency rule for exactly that reason.

const TIMEOUT_MS = 5_000;

type Channel = {
  type: string;
  config: Record<string, string>;
  conditions?: Record<string, unknown>;
  template?: string;
};
type Result = { ok: boolean; error?: string };

/**
 * One human-readable line, reused by every chat-style channel and the email subject.
 * Takes a translator instead of reaching for one itself so it stays a pure function — the
 * caller has already resolved the deployment language, and the test can pass any locale.
 *
 * The server name and the year are appended rather than interpolated: they are the same
 * parenthesised suffix in every language, and keeping them out of the template means one
 * key per sentence instead of one per combination.
 */
export function describe(
  t: Translate,
  event: NotificationEvent,
  payload: Record<string, unknown>,
): string {
  const p = payload as Record<string, any>;
  const server = p.server?.label ? ` (${p.server.label})` : '';
  const user = p.user ?? t('notify.someone');
  switch (event) {
    case 'playback.start':
      return t('notify.playbackStart', { user, title: p.title }) + server;
    case 'playback.stop':
      return (
        (p.percent != null
          ? t('notify.playbackStopAt', { user, title: p.title, percent: p.percent })
          : t('notify.playbackStop', { user, title: p.title })) + server
      );
    case 'server.down':
      return t('notify.serverDown', { server: p.server?.label ?? t('notify.aMediaServer') });
    case 'media.added':
      return t('notify.mediaAdded', { title: p.title }) + (p.year ? ` (${p.year})` : '') + server;
    case 'monitor.alert':
      return t('notify.monitorAlert', { message: p.message });
    case 'digest':
      return p.topTitle
        ? t('notify.digestTop', {
            period: p.periodLabel,
            watchtime: p.watchtime,
            plays: p.plays,
            topTitle: p.topTitle,
          })
        : t('notify.digest', { period: p.periodLabel, watchtime: p.watchtime, plays: p.plays });
    default:
      return `${event}`;
  }
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Result> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function postForm(url: string, params: Record<string, string>): Promise<Result> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function sendEmail(config: Record<string, string>, subject: string, text: string): Promise<Result> {
  return transportSend(config, { to: config.to, subject, text });
}

async function transportSend(
  config: Record<string, string>,
  message: { to?: string; bcc?: string[]; subject: string; text?: string; html?: string },
): Promise<Result> {
  // Lazy import: nodemailer pulls in Node's tls/net machinery that only email needs, and
  // most deployments will never configure a channel of this type.
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.default.createTransport({
    host: config.smtpHost,
    port: Number(config.smtpPort) || 587,
    secure: Number(config.smtpPort) === 465,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });
  try {
    await transport.sendMail({ from: config.from, ...message });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Sends one HTML mail through the first configured email channel. The newsletter has its
 * own recipient list but no reason to ask an admin for a second set of SMTP credentials —
 * if mail already works for notifications, it works for this.
 */
export async function sendMail(
  to: string[],
  subject: string,
  html: string,
): Promise<Result> {
  const rows = await db.select().from(notificationChannels).where(eq(notificationChannels.type, 'email'));
  const config = rows.map((row) => decryptConfig(row.config)).find((c) => c.smtpHost);
  if (!config) {
    return { ok: false, error: 'No email channel is configured — add one under Notifications.' };
  }
  // BCC: subscribers must not learn each other's addresses from a mail they did not send.
  return transportSend(config, { to: config.from || config.to, bcc: to, subject, html });
}

/* ------------------------------------------------------------------ *
 * Script channel
 *
 * Tautulli's most-used escape hatch: run something local when an event fires. Everything
 * else in this file is an outbound HTTP request, so this one is the only place where an
 * admin-supplied string could become code, and it is fenced accordingly:
 *
 *   - the command is a bare filename, resolved inside SCRIPTS_DIR and nowhere else, so a
 *     path or a dot segment cannot reach out of it;
 *   - execFile, never a shell, so nothing in the name or the payload is ever parsed as one;
 *   - the payload arrives in the environment rather than as arguments, which keeps a title
 *     with a leading dash from being read as a flag;
 *   - a timeout, because the sync that fires this sits in a page render.
 * ------------------------------------------------------------------ */

const SCRIPTS_DIR = process.env.WATCHARR_SCRIPTS_DIR ?? './data/scripts';
const SCRIPT_TIMEOUT_MS = 10_000;
/** Filenames only. No separators, no leading dot, so "..", "/etc/x" and ".env" all fail. */
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function runScript(
  command: string | undefined,
  event: NotificationEvent,
  text: string,
  payload: Record<string, unknown>,
): Promise<Result> {
  if (!command || !SCRIPT_NAME.test(command)) {
    return { ok: false, error: 'Script name must be a plain file name inside the scripts folder' };
  }
  const { execFile } = await import('node:child_process');
  const { resolve, join } = await import('node:path');

  const dir = resolve(SCRIPTS_DIR);
  const file = join(dir, command);
  // Belt and braces: the pattern above already rules out separators, but the resolved path
  // is what actually gets executed, so that is what gets checked.
  if (!file.startsWith(dir)) return { ok: false, error: 'Script is outside the scripts folder' };

  return new Promise<Result>((done) => {
    execFile(
      file,
      [],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        // A clean environment plus the event: the app's own secrets (SESSION_SECRET, the
        // database path) have no business in a script an admin dropped into a folder.
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: process.env.NODE_ENV,
          WATCHARR_EVENT: event,
          WATCHARR_TEXT: text,
          WATCHARR_PAYLOAD: JSON.stringify(payload),
        },
        maxBuffer: 256 * 1024,
      },
      (error: Error | null) => done(error ? { ok: false, error: error.message } : { ok: true }),
    );
  });
}

/** Poster URL for a payload, if the event carries enough to build one and APP_URL is set. */
function posterFor(payload: Record<string, unknown>): string | null {
  const p = payload as Record<string, any>;
  const slug = p.server?.slug;
  const itemId = p.itemId;
  return typeof slug === 'string' && typeof itemId === 'string' ? publicArtUrl(slug, itemId) : null;
}

const AMBER = 0xffb020; // matches --beam; amber means "this is data", same rule as the charts

/** One delivery attempt for one channel. */
async function send(
  channel: Channel,
  event: NotificationEvent,
  payload: Record<string, unknown>,
  t: Translate,
): Promise<Result> {
  // A template replaces the built-in sentence entirely; an empty one keeps it. Falling
  // back when the rendered result is blank means a template made only of placeholders the
  // event does not carry sends the normal wording instead of an empty message.
  const text =
    (channel.template ? renderTemplate(channel.template, { event, ...payload }) : '') ||
    describe(t, event, payload);
  const image = posterFor(payload);
  const { config } = channel;
  switch (channel.type as ChannelType | 'webhook') {
    case 'webhook':
      return postJson(config.url, { event, at: new Date().toISOString(), ...payload });
    case 'discord':
      return postJson(config.url, {
        embeds: [
          {
            description: text.slice(0, 2000),
            color: AMBER,
            timestamp: new Date().toISOString(),
            ...(image ? { thumbnail: { url: image } } : {}),
          },
        ],
      });
    case 'slack':
      return postJson(config.url, {
        text,
        attachments: [{ color: '#ffb020', text, ...(image ? { thumb_url: image } : {}) }],
      });
    case 'telegram':
      return postJson(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        chat_id: config.chatId,
        text,
      });
    case 'pushover':
      return postForm('https://api.pushover.net/1/messages.json', {
        token: config.appToken,
        user: config.userKey,
        title: 'Watcharr',
        message: text,
      });
    case 'pushbullet':
      return postJson(
        'https://api.pushbullet.com/v2/pushes',
        { type: 'note', title: 'Watcharr', body: text },
        { 'Access-Token': config.accessToken },
      );
    case 'script':
      return runScript(config.command, event, text, payload);
    case 'email':
      return sendEmail(config, `Watcharr: ${text}`, text);
    default:
      return { ok: false, error: `Unknown channel type "${channel.type}"` };
  }
}

/**
 * Every enabled destination subscribed to one event and not filtered out by its own
 * conditions: legacy webhook plus channel rows. The webhook has no conditions — it is a
 * single field on the settings page, not a row with a form.
 */
async function channelsFor(
  event: NotificationEvent,
  payload: Record<string, unknown>,
): Promise<(Channel & { id: number | null; name: string })[]> {
  const { webhookUrl, webhookEvents } = await getSettings();
  const channels: (Channel & { id: number | null; name: string })[] = [];
  if (webhookUrl && webhookEvents.includes(event)) {
    channels.push({ type: 'webhook', config: { url: webhookUrl }, id: null, name: 'Generic webhook' });
  }

  const rows = await db
    .select({
      id: notificationChannels.id,
      type: notificationChannels.type,
      name: notificationChannels.name,
      config: notificationChannels.config,
      conditions: notificationChannels.conditions,
      template: notificationChannels.template,
    })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.enabled, true),
        sql`EXISTS (SELECT 1 FROM json_each(${notificationChannels.events}) WHERE json_each.value = ${event})`,
      ),
    )
    .catch(() => []);
  channels.push(
    ...rows
      // In JavaScript rather than SQL: the rule is shared with the admin form, which
      // cannot run a query, and a filter that decides who gets woken up is worth testing.
      .filter((row) => matchesConditions(row.conditions, payload))
      .map((row) => ({
        id: row.id,
        type: row.type,
        name: row.name,
        config: decryptConfig(row.config),
        conditions: row.conditions,
        template: row.template,
      })),
  );
  return channels;
}

async function logDelivery(
  channel: { type: string; id: number | null; name: string },
  event: NotificationEvent,
  result: Result,
) {
  try {
    await db.insert(notificationLog).values({
      channelType: channel.type,
      channelId: channel.id,
      channelName: channel.name,
      event,
      success: result.ok,
      error: result.ok ? null : (result.error ?? null),
    });
  } catch {
    // The log is a convenience, never a reason to fail delivery bookkeeping.
  }
}

/**
 * Sends one event to every enabled destination subscribed to it: the legacy webhook field
 * on app_settings, plus every matching row in notification_channels. Every attempt — success
 * or failure — is recorded in notification_log, so a bad Discord URL is visible in the admin
 * UI instead of vanishing after its one retry.
 *
 * ponytail: one retry per channel, then the event is dropped — no queue, no dead letter
 * table. A notification is not a ledger; the log above is only a record of what happened,
 * not a replay mechanism.
 */
export async function dispatch(event: NotificationEvent, payload: Record<string, unknown>) {
  const channels = await channelsFor(event, payload);
  // Resolved once for the whole fan-out: there is no session out here, so every channel
  // gets the deployment language rather than anybody's personal one.
  const t = await getDefaultT();

  await Promise.all([
    ...channels.map(async (channel) => {
      let result = await send(channel, event, payload, t);
      if (!result.ok) result = await send(channel, event, payload, t);
      await logDelivery(channel, event, result);
    }),
    mailSubscribers(event, payload, t),
  ]);
}

/* ------------------------------------------------------------------ *
 * Personal subscriptions
 *
 * The channels above belong to the admin and fan an event out to the whole deployment.
 * These belong to one person: an address on their own user row plus the events they asked
 * for. They ride the same SMTP credentials as the newsletter, so a user subscription costs
 * no extra configuration.
 * ------------------------------------------------------------------ */

export interface UserPrefs {
  email: string | null;
  events: string[];
}

export async function getUserPrefs(userId: number): Promise<UserPrefs> {
  const [row] = await db
    .select({ email: users.notifyEmail, events: users.notifyEvents })
    .from(users)
    .where(eq(users.id, userId));
  return { email: row?.email ?? null, events: row?.events ?? [] };
}

export async function setUserPrefs(userId: number, prefs: UserPrefs): Promise<void> {
  await db
    .update(users)
    .set({ notifyEmail: prefs.email, notifyEvents: prefs.events })
    .where(eq(users.id, userId));
}

/**
 * What a non-admin is allowed to be told. Playback events name somebody by username, and
 * the rest is operator data (a server going down, a monitor threshold, the digest over
 * everyone's viewing) — mailing those to any user who ticks the box would hand out other
 * people's activity. Admins already see all of it in the UI.
 */
export function mayReceive(
  event: NotificationEvent,
  user: { isAdmin: boolean; username: string },
  payload: Record<string, unknown>,
): boolean {
  if (user.isAdmin) return true;
  if (event === 'media.added') return true;
  if (event.startsWith('playback.')) return payload.user === user.username;
  return false;
}

/** Events a user may pick from — the same rule as mayReceive, for the form. */
export function selectableEvents(isAdmin: boolean): NotificationEvent[] {
  return isAdmin
    ? ['playback.start', 'playback.stop', 'server.down', 'media.added', 'monitor.alert', 'digest']
    : ['playback.start', 'playback.stop', 'media.added'];
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One mail per event to everyone who subscribed to it personally, recipients in BCC. */
async function mailSubscribers(
  event: NotificationEvent,
  payload: Record<string, unknown>,
  t: Translate,
): Promise<void> {
  const rows = await db
    .select({
      email: users.notifyEmail,
      events: users.notifyEvents,
      isAdmin: users.isAdmin,
      globalAdmin: users.globalAdmin,
      username: users.username,
    })
    .from(users)
    .where(isNotNull(users.notifyEmail))
    .catch(() => []);

  const recipients = rows
    .filter(
      (row) =>
        row.events.includes(event) &&
        mayReceive(event, { isAdmin: row.isAdmin || row.globalAdmin, username: row.username }, payload),
    )
    .map((row) => row.email as string);
  if (!recipients.length) return;

  const text = describe(t, event, payload);
  const result = await sendMail(recipients, `Watcharr: ${text}`, `<p>${escapeHtml(text)}</p>`);
  await logDelivery({ type: 'email', id: null, name: 'Personal subscriptions' }, event, result);
}

/** Fires a synthetic event straight at one channel, bypassing its event filter. */
export async function sendTest(channelId: number | 'webhook'): Promise<Result> {
  const t = await getDefaultT();
  const payload = {
    user: 'Test',
    title: t('notify.testTitle'),
    server: { label: 'Watcharr' },
  };
  let channel: (Channel & { id: number | null; name: string }) | undefined;
  if (channelId === 'webhook') {
    const { webhookUrl } = await getSettings();
    if (!webhookUrl) return { ok: false, error: 'No webhook URL configured' };
    channel = { type: 'webhook', config: { url: webhookUrl }, id: null, name: 'Generic webhook' };
  } else {
    const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    if (!row) return { ok: false, error: 'Channel not found' };
    // The template comes along so a test shows the wording that will actually be sent; the
    // conditions deliberately do not, because a test must always arrive.
    channel = {
      type: row.type,
      config: decryptConfig(row.config),
      template: row.template,
      id: row.id,
      name: row.name,
    };
  }

  const result = await send(channel, 'playback.start', payload, t);
  await logDelivery(channel, 'playback.start', result);
  return result;
}

export interface LogEntry {
  id: number;
  channelType: string;
  channelName: string;
  event: string;
  success: boolean;
  error: string | null;
  createdAt: Date;
}

export async function listNotificationLog(limit = 100): Promise<LogEntry[]> {
  return db.select().from(notificationLog).orderBy(desc(notificationLog.createdAt)).limit(limit);
}

/**
 * Fire and forget. The sync runs inside a page render, so awaiting delivery would put a
 * slow or hanging endpoint straight into the user's page load time.
 */
export function notify(event: NotificationEvent, payload: Record<string, unknown>) {
  void dispatch(event, payload).catch(() => {});
}

// Channel config (bot tokens, webhook URLs, SMTP credentials) is encrypted as one blob,
// the same way media server tokens are — see server/crypto.ts. A JSON column would leave
// it sitting in the database in plain text.
function decryptConfig(stored: string): Record<string, string> {
  if (!stored) return {};
  try {
    return JSON.parse(decryptSecret(stored));
  } catch {
    return {};
  }
}

/** What the admin UI is allowed to see: which fields are set, never their values. */
export interface ChannelSummary {
  id: number;
  type: string;
  name: string;
  configuredFields: string[];
  events: string[];
  /** Not a secret, unlike config — the form shows and edits these directly. */
  conditions: Record<string, unknown>;
  template: string;
  enabled: boolean;
  createdAt: Date;
}

export async function listChannels(): Promise<ChannelSummary[]> {
  const rows = await db.select().from(notificationChannels).orderBy(notificationChannels.id);
  return rows.map((row) => {
    const config = decryptConfig(row.config);
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      configuredFields: Object.keys(config).filter((k) => config[k]),
      events: row.events,
      conditions: row.conditions,
      template: row.template,
      enabled: row.enabled,
      createdAt: row.createdAt,
    };
  });
}

export async function createChannel(input: {
  type: string;
  name: string;
  config: Record<string, string>;
  events: string[];
  conditions?: Record<string, unknown>;
  template?: string;
}): Promise<{ id: number }> {
  const [row] = await db
    .insert(notificationChannels)
    .values({ ...input, config: encryptSecret(JSON.stringify(input.config)) })
    .returning({ id: notificationChannels.id });
  return row;
}

/**
 * Config is merged rather than replaced: the edit form only submits fields the admin
 * actually typed into (blank means "leave unchanged"), same convention as server tokens.
 */
export async function updateChannel(
  id: number,
  input: Partial<{
    name: string;
    config: Record<string, string>;
    events: string[];
    conditions: Record<string, unknown>;
    template: string;
    enabled: boolean;
  }>,
): Promise<void> {
  const patch: Partial<typeof notificationChannels.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.events !== undefined) patch.events = input.events;
  // Replaced rather than merged, unlike config: an empty condition means "no longer
  // filter on this", and there is no secret to preserve.
  if (input.conditions !== undefined) patch.conditions = input.conditions;
  if (input.template !== undefined) patch.template = input.template;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.config) {
    const [current] = await db
      .select({ config: notificationChannels.config })
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id));
    const merged = { ...(current ? decryptConfig(current.config) : {}), ...input.config };
    patch.config = encryptSecret(JSON.stringify(merged));
  }
  if (Object.keys(patch).length) {
    await db.update(notificationChannels).set(patch).where(eq(notificationChannels.id, id));
  }
}

export async function deleteChannel(id: number): Promise<void> {
  await db.delete(notificationChannels).where(eq(notificationChannels.id, id));
}
