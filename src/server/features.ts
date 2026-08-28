import type { TranslationKey } from '@/i18n';

// Labels are translation keys, not text: this module is imported by client components and
// cannot await getT(). Named *Key so a caller that still renders the raw field fails to
// compile instead of printing "feature.suggestions" at the user.

// Feature toggles are stored in app_config.features and default to on when unset.
export const FEATURE_FLAGS = [
  { key: 'suggestions', labelKey: 'feature.suggestions' },
  { key: 'watchlistSync', labelKey: 'feature.watchlistSync' },
  { key: 'serverWideStats', labelKey: 'feature.serverWideStats' },
  // Self-hosted deployments must be able to stop the app from calling out to GitHub.
  { key: 'updateCheck', labelKey: 'feature.updateCheck' },
  // Live event socket to the media servers. Off falls back to polling alone, which is
  // what every install did before — the socket only decides how quickly a change is
  // noticed, never what is stored.
  { key: 'liveSocket', labelKey: 'feature.liveSocket' },
] as const satisfies readonly { key: string; labelKey: TranslationKey }[];

export type FeatureKey = (typeof FEATURE_FLAGS)[number]['key'];

/**
 * Events a notification channel can be subscribed to. Listed here rather than in
 * server/notifications.ts because the settings form is a client component and must not
 * import a server-only module.
 */
export const NOTIFICATION_EVENTS = [
  { key: 'playback.start', labelKey: 'event.playbackStart' },
  { key: 'playback.stop', labelKey: 'event.playbackStop' },
  { key: 'server.down', labelKey: 'event.serverDown' },
  { key: 'media.added', labelKey: 'event.mediaAdded' },
  { key: 'monitor.alert', labelKey: 'event.monitorAlert' },
  { key: 'digest', labelKey: 'event.digest' },
] as const satisfies readonly { key: string; labelKey: TranslationKey }[];

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]['key'];

/**
 * Additional channel types besides the legacy generic webhook (still configured on the
 * Settings page). Each entry names the config fields its admin form needs to collect —
 * the form in NotificationsForm.tsx is generated from this list rather than hand-built
 * per type, so a new channel is one entry here plus one sender in server/notifications.ts.
 *
 * `label` stays plain text because it is a product name; only the field labels are
 * translated, and those carry a key like everything else in this module.
 */
export const CHANNEL_TYPES = [
  {
    type: 'discord',
    label: 'Discord',
    fields: [{ key: 'url', labelKey: 'notifications.field.webhookUrl', type: 'url' }],
  },
  {
    type: 'slack',
    label: 'Slack',
    fields: [{ key: 'url', labelKey: 'notifications.field.incomingWebhookUrl', type: 'url' }],
  },
  {
    type: 'telegram',
    label: 'Telegram',
    fields: [
      { key: 'botToken', labelKey: 'notifications.field.botToken', type: 'password' },
      { key: 'chatId', labelKey: 'notifications.field.chatId', type: 'text' },
    ],
  },
  {
    type: 'pushover',
    label: 'Pushover',
    fields: [
      { key: 'appToken', labelKey: 'notifications.field.appToken', type: 'password' },
      { key: 'userKey', labelKey: 'notifications.field.userKey', type: 'password' },
    ],
  },
  {
    type: 'pushbullet',
    label: 'Pushbullet',
    fields: [{ key: 'accessToken', labelKey: 'notifications.field.accessToken', type: 'password' }],
  },
  {
    type: 'script',
    label: 'Script',
    fields: [{ key: 'command', labelKey: 'notifications.field.command', type: 'text' }],
  },
  {
    type: 'email',
    label: 'Email (SMTP)',
    fields: [
      { key: 'smtpHost', labelKey: 'notifications.field.smtpHost', type: 'text' },
      { key: 'smtpPort', labelKey: 'notifications.field.smtpPort', type: 'text' },
      { key: 'smtpUser', labelKey: 'notifications.field.smtpUser', type: 'text' },
      { key: 'smtpPass', labelKey: 'notifications.field.smtpPass', type: 'password' },
      { key: 'from', labelKey: 'notifications.field.from', type: 'text' },
      { key: 'to', labelKey: 'notifications.field.to', type: 'text' },
    ],
  },
] as const satisfies readonly {
  type: string;
  label: string;
  fields: readonly { key: string; labelKey: TranslationKey; type: string }[];
}[];

export type ChannelType = (typeof CHANNEL_TYPES)[number]['type'];

export function isEnabled(features: Record<string, boolean> | null, key: string): boolean {
  return features?.[key] !== false;
}

/* ------------------------------------------------------------------ *
 * Channel conditions and message templates
 *
 * The event list answers "what happened". These answer "does this destination care" and
 * "how should it read". Both are pure and live here rather than in server/notifications.ts
 * because the admin form is a client component and must not import a server-only module —
 * and because a filter that decides whether somebody gets woken up deserves a test.
 * ------------------------------------------------------------------ */

export interface ChannelConditions {
  /** Usernames this channel cares about. Empty means every user. */
  users?: string[];
  /** 'movie' | 'episode' | … as the media server reports it. Empty means every type. */
  mediaTypes?: string[];
  /**
   * Section keys ("<serverId>:<sectionId>", see library.ts::sectionKey). Empty means every
   * library. An event whose library could not be resolved is not filtered by this — see
   * matchesConditions() for why that is the safe direction.
   */
  libraries?: string[];
  /** Only fire while the stream is being transcoded. */
  transcodeOnly?: boolean;
}

/** Field list the admin form renders. One entry here is one input there. */
export const CONDITION_FIELDS = [
  { key: 'users', labelKey: 'notifications.condition.users', type: 'list' },
  { key: 'mediaTypes', labelKey: 'notifications.condition.mediaTypes', type: 'list' },
  { key: 'libraries', labelKey: 'notifications.condition.libraries', type: 'set' },
  { key: 'transcodeOnly', labelKey: 'notifications.condition.transcodeOnly', type: 'boolean' },
] as const satisfies readonly { key: string; labelKey: TranslationKey; type: string }[];

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];

/**
 * Whether one event passes a channel's conditions.
 *
 * An unset condition never filters, so a channel configured before this existed keeps
 * receiving exactly what it did. A condition that the event cannot answer — asking for a
 * transcode on "server went down" — also passes rather than silently swallowing the alert:
 * the event filter is where an admin says they do not want that event at all.
 */
export function matchesConditions(
  conditions: ChannelConditions | Record<string, unknown> | null | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!conditions) return true;
  const users = list((conditions as ChannelConditions).users);
  const mediaTypes = list((conditions as ChannelConditions).mediaTypes);
  const transcodeOnly = Boolean((conditions as ChannelConditions).transcodeOnly);

  if (users.length && typeof payload.user === 'string' && !users.includes(payload.user)) {
    return false;
  }
  if (
    mediaTypes.length &&
    typeof payload.mediaType === 'string' &&
    !mediaTypes.includes(payload.mediaType)
  ) {
    return false;
  }
  // The library is resolved from the cached listing, so it can legitimately be unknown —
  // a title added minutes ago, or a cache that has not been filled yet. Unknown must let
  // the event through: a filter that silently drops what it cannot classify would turn a
  // cold cache into missing notifications nobody can explain afterwards.
  const libraries = list((conditions as ChannelConditions).libraries);
  if (
    libraries.length &&
    typeof payload.sectionKey === 'string' &&
    !libraries.includes(payload.sectionKey)
  ) {
    return false;
  }
  // Only applied where the event actually reports it: playback.stop carries no transcode
  // flag, and treating "absent" as "not transcoding" would mute every stop event.
  if (transcodeOnly && typeof payload.transcoding === 'boolean' && !payload.transcoding) {
    return false;
  }
  return true;
}

/** Placeholders a template may use, shown next to the input in the admin form. */
export const TEMPLATE_TOKENS = [
  'user',
  'title',
  'server',
  'event',
  'mediaType',
  'library',
  'year',
  'percent',
  'client',
  'device',
  'message',
] as const;

/**
 * Substitutes {placeholders} from the event payload. An unknown or missing one renders as
 * an empty string rather than as its own name — a notification that reads "{grandparent}"
 * is worse than one with a gap. `server` is the label rather than the object.
 */
export function renderTemplate(template: string, payload: Record<string, unknown>): string {
  const server = payload.server as { label?: string } | undefined;
  return template
    .replace(/\{(\w+)\}/g, (_match, token: string) => {
      const value = token === 'server' ? server?.label : payload[token];
      return value == null ? '' : String(value);
    })
    .trim();
}
