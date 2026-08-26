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
