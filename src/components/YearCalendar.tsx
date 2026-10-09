import Link from 'next/link';
import type { LabelledValue } from '@/server/stats';
import { getLocale, getT } from '@/i18n/server';

/** Intensity levels 1..4 from the quartiles of the active days, so one huge day cannot flatten the rest. */
export function levelsFor(values: number[]): (value: number) => 0 | 1 | 2 | 3 | 4 {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (!active.length) return () => 0;
  const at = (q: number) => active[Math.min(active.length - 1, Math.floor(active.length * q))];
  const [q1, q2, q3] = [at(0.25), at(0.5), at(0.75)];
  return (value) => (value <= 0 ? 0 : value <= q1 ? 1 : value <= q2 ? 2 : value <= q3 ? 3 : 4);
}

/**
 * A year of watching as a calendar: one column per week, Monday at the top, month names
 * above. The film-strip heatmap on the statistics page answers "how much"; this one answers
 * "when", so it carries the labels the strip leaves out. Brightness is amber because every
 * cell is a value read off the server.
 */
export default async function YearCalendar({
  data,
  format,
  hrefFor,
}: {
  /** One entry per day, oldest first, label = YYYY-MM-DD. */
  data: LabelledValue[];
  format: (value: number) => string;
  hrefFor?: (day: string) => string;
}) {
  const t = await getT();
  const locale = await getLocale();
  if (!data.length) return <p className="muted">{t('common.noData')}</p>;

  const level = levelsFor(data.map((day) => day.value));
  const lead = (new Date(`${data[0].label}T00:00:00Z`).getUTCDay() + 6) % 7;
  const cells: (LabelledValue | null)[] = [...Array<null>(lead).fill(null), ...data];
  const weeks = Math.ceil(cells.length / 7);
  const monthName = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const today = data[data.length - 1].label;
  const peak = data.reduce((best, day) => (day.value > best.value ? day : best), data[0]);
  const dayName = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });

  // A month label sits over the first week that contains the 1st (or the very first week).
  const months: { week: number; name: string }[] = [];
  cells.forEach((cell, index) => {
    if (!cell) return;
    const week = Math.floor(index / 7);
    if (!(cell.label.endsWith('-01') || (index === lead && !months.length))) return;
    const name = monthName.format(new Date(`${cell.label}T00:00:00Z`));
    const previous = months[months.length - 1];
    // A label needs about three columns of room; the partial first month yields to the next.
    if (previous && week - previous.week < 3) months.pop();
    months.push({ week, name });
  });

  const weekdays = [t('weekday.mon'), '', t('weekday.wed'), '', t('weekday.fri'), '', ''];

  return (
    <div className="calendar-wrap">
      <div className="calendar" style={{ ['--weeks' as string]: weeks }}>
        <span />
        <div className="calendar-months" aria-hidden>
          {months.map((month) => (
            <span key={`${month.week}-${month.name}`} style={{ gridColumn: `${month.week + 1} / span 3`, gridRow: 1 }}>
              {month.name}
            </span>
          ))}
        </div>

        <div className="calendar-days" aria-hidden>
          {weekdays.map((name, index) => (
            <span key={index}>{name}</span>
          ))}
        </div>

        <div className="calendar-grid">
          {cells.map((cell, index) => {
            if (cell === null) return <span key={`blank-${index}`} className="day blank" />;
            const tip = `${cell.label} · ${format(cell.value)}`;
            const className = `day l${level(cell.value)}${cell.label === today ? ' today' : ''}`;
            return hrefFor && cell.value > 0 ? (
              <Link
                key={cell.label}
                className={className}
                href={hrefFor(cell.label)}
                // A year of cells would otherwise prefetch a few hundred dynamic pages, and
                // as tab stops they would bury the rest of the page: keyboard users get the
                // busiest-day link below, pointer users get every cell.
                prefetch={false}
                tabIndex={-1}
                data-tip={tip}
                aria-label={tip}
              />
            ) : (
              <span key={cell.label} className={className} data-tip={tip} />
            );
          })}
        </div>
      </div>

      <div className="calendar-foot">
        {hrefFor && peak.value > 0 ? (
          <Link className="calendar-peak" href={hrefFor(peak.label)} prefetch={false}>
            <span>{t('dash.peakDay')}</span>
            <span className="num">
              {dayName.format(new Date(`${peak.label}T00:00:00Z`))} · {format(peak.value)}
            </span>
          </Link>
        ) : (
          <span />
        )}
        <div className="calendar-legend" aria-hidden>
          <span>{t('dash.less')}</span>
          {[0, 1, 2, 3, 4].map((step) => (
            <span key={step} className={`day l${step}`} />
          ))}
          <span>{t('dash.more')}</span>
        </div>
      </div>
    </div>
  );
}
