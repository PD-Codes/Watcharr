// Superseded by ./notifications.ts, which generalized the single outgoing webhook into
// several channel types (Discord, Slack, Telegram, Pushover, Pushbullet, email) plus the
// legacy webhook field. Re-exported here because the sandbox this file was edited in could
// not delete the old path — new code should import from ./notifications directly.
export * from './notifications';
