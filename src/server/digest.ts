import 'server-only';
import { formatDuration } from '@/components/format';
import { getSettings, updateSettings } from './config';
import { notify } from './notifications';
import { getTopTitles, getTotals } from './stats';

// Periodic summary across the whole deployment, built from the same aggregates the admin
// stats page already uses. Checked from the same activity-sync tick as everything else in
// monitor.ts — no separate scheduler, this app has exactly one clock.

const DAY_MS = 86_400_000;

function periodDays(frequency: string): number {
  return frequency === 'daily' ? 1 : 7;
}

function due(lastSentAt: Date | null, frequency: string): boolean {
  if (!lastSentAt) return true;
  return Date.now() - lastSentAt.getTime() >= periodDays(frequency) * DAY_MS;
}

export async function checkDigest() {
  const settings = await getSettings();
  if (!settings.digestEnabled) return;
  if (!due(settings.digestLastSentAt, settings.digestFrequency)) return;

  const days = periodDays(settings.digestFrequency);
  const scope = { userId: null } as const;
  const [totals, titles] = await Promise.all([getTotals(scope, days), getTopTitles(scope, 1, 'time')]);

  notify('digest', {
    periodLabel: settings.digestFrequency === 'daily' ? 'Yesterday' : 'This week',
    watchtime: formatDuration(totals.watchtimeMs),
    plays: totals.plays,
    topTitle: titles[0]?.label ?? null,
  });

  // Recorded regardless of delivery success: a broken channel should not resend the same
  // digest every five seconds until someone notices, same reasoning as the sync throttles.
  await updateSettings({ digestLastSentAt: new Date() });
}
