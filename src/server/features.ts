// Feature toggles are stored in app_config.features and default to on when unset.
export const FEATURE_FLAGS = [
  { key: 'suggestions', label: 'Suggestions' },
  { key: 'watchlistSync', label: 'Sync the Plex watchlist' },
  { key: 'serverWideStats', label: 'Server-wide statistics for admins' },
  // Self-hosted deployments must be able to stop the app from calling out to GitHub.
  { key: 'updateCheck', label: 'Check GitHub for Watcharr updates' },
] as const;

export type FeatureKey = (typeof FEATURE_FLAGS)[number]['key'];

/**
 * Events a notification channel can be subscribed to. Listed here rather than in
 * server/notifications.ts because the settings form is a client component and must not
 * import a server-only module.
 */
export const NOTIFICATION_EVENTS = [
  { key: 'playback.start', label: 'A stream starts' },
  { key: 'playback.stop', label: 'A stream stops' },
  { key: 'server.down', label: 'A media server becomes unreachable' },
  { key: 'media.added', label: 'New media appears in a library' },
  { key: 'monitor.alert', label: 'A monitoring threshold is exceeded' },
  { key: 'digest', label: 'Periodic summary (see Settings for the schedule)' },
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]['key'];

/**
 * Additional channel types besides the legacy generic webhook (still configured on the
 * Settings page). Each entry names the config fields its admin form needs to collect —
 * the form in NotificationsForm.tsx is generated from this list rather than hand-built
 * per type, so a new channel is one entry here plus one sender in server/notifications.ts.
 */
export const CHANNEL_TYPES = [
  {
    type: 'discord',
    label: 'Discord',
    fields: [{ key: 'url', label: 'Webhook URL', type: 'url' }],
  },
  {
    type: 'slack',
    label: 'Slack',
    fields: [{ key: 'url', label: 'Incoming webhook URL', type: 'url' }],
  },
  {
    type: 'telegram',
    label: 'Telegram',
    fields: [
      { key: 'botToken', label: 'Bot token', type: 'password' },
      { key: 'chatId', label: 'Chat id', type: 'text' },
    ],
  },
  {
    type: 'pushover',
    label: 'Pushover',
    fields: [
      { key: 'appToken', label: 'Application token', type: 'password' },
      { key: 'userKey', label: 'User key', type: 'password' },
    ],
  },
  {
    type: 'pushbullet',
    label: 'Pushbullet',
    fields: [{ key: 'accessToken', label: 'Access token', type: 'password' }],
  },
  {
    type: 'email',
    label: 'Email (SMTP)',
    fields: [
      { key: 'smtpHost', label: 'SMTP host', type: 'text' },
      { key: 'smtpPort', label: 'SMTP port', type: 'text' },
      { key: 'smtpUser', label: 'SMTP username', type: 'text' },
      { key: 'smtpPass', label: 'SMTP password', type: 'password' },
      { key: 'from', label: 'From address', type: 'text' },
      { key: 'to', label: 'To address', type: 'text' },
    ],
  },
] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number]['type'];

export function isEnabled(features: Record<string, boolean> | null, key: string): boolean {
  return features?.[key] !== false;
}
