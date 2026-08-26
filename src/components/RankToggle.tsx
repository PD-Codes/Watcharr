import Link from 'next/link';
import type { RankBy } from '@/server/stats';
import { getT } from '@/i18n/server';

/**
 * Switches the top lists between play count and watch time. The two rankings answer
 * different questions — a daily sitcom wins on plays, a film trilogy wins on time — and
 * showing both at once is what made these pages twice as long as they needed to be.
 */
export default async function RankToggle({
  base,
  by,
  days,
}: {
  base: string;
  by: RankBy;
  days: number;
}) {
  const t = await getT();
  const href = (value: RankBy) => `${base}?days=${days}&by=${value}`;
  return (
    <div className="seg">
      <Link href={href('count')} className={by === 'count' ? 'on' : undefined}>
        {t('rank.byPlays')}
      </Link>
      <Link href={href('time')} className={by === 'time' ? 'on' : undefined}>
        {t('rank.byWatchTime')}
      </Link>
    </div>
  );
}
