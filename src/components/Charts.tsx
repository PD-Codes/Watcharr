import { Fragment } from 'react';
import Link from 'next/link';
import type { LabelledValue } from '@/server/stats';
import { getT } from '@/i18n/server';
import type { Translate } from '@/i18n';

// Charts are server-rendered SVG. Interaction is CSS plus the shared Tooltip component,
// so there is no charting dependency and no client-side data fetching.
//
// Colour rule: amber is data. Intensity separates series, never hue.

const RAMP = [
  'var(--beam)',
  'rgba(255, 176, 32, 0.72)',
  'rgba(255, 176, 32, 0.5)',
  'rgba(255, 176, 32, 0.34)',
  'rgba(255, 176, 32, 0.22)',
];

const niceMax = (values: number[]) => Math.max(1, ...values);
const identity = (value: number) => String(value);

export function StatCard({
  label,
  value,
  hint,
  info,
  href,
  trend,
  spark,
}: {
  label: string;
  value: string;
  hint?: string;
  info?: string;
  href?: string;
  /** Change against the previous period, in percent. */
  trend?: number | null;
  /** Tiny series drawn under the number for shape at a glance. */
  spark?: number[];
}) {
  const body = (
    <>
      <p className="stat-label">
        {label}
        {info && (
          <span className="info" data-tip={info} aria-label={info} tabIndex={0}>
            i
          </span>
        )}
      </p>
      <p className="stat-value">{value}</p>
      {spark && spark.length > 1 && <Sparkline values={spark} />}
      <p className="stat-hint">
        {trend !== undefined && trend !== null && (
          <span className={`trend ${trend >= 0 ? 'up' : 'down'}`}>
            {trend >= 0 ? '▲' : '▼'} {Math.abs(trend)}%
          </span>
        )}
        {hint}
      </p>
    </>
  );

  return href ? (
    <Link className="card stat stat-link" href={href}>
      {body}
    </Link>
  ) : (
    <div className="card stat">{body}</div>
  );
}

export async function EmptyChart({ label }: { label?: string }) {
  const t = await getT();
  return <p className="muted">{label ?? t('common.noData')}</p>;
}

/** Bare trend line for stat cards — no axes, no labels, just the shape. */
export function Sparkline({ values }: { values: number[] }) {
  const max = niceMax(values);
  const step = 100 / Math.max(1, values.length - 1);
  const points = values.map((value, index) => `${index * step},${20 - (value / max) * 18}`);

  return (
    <svg className="spark" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden>
      <polyline points={points.join(' ')} fill="none" stroke="var(--beam-dim)" strokeWidth="1.5" />
    </svg>
  );
}

/** Horizontal bars — ranked lists with long labels (titles, genres, devices, clients). */
/**
 * Accessible name for a chart. `role="img"` without a name announces as an empty
 * image, which in a statistics app hides the actual content from screen readers.
 * Deriving it from the data means no caller can forget to pass one.
 */
function describe(
  t: Translate,
  data: LabelledValue[],
  format: (value: number) => string,
): string {
  if (!data.length) return t('chart.empty');
  const peak = data.reduce((best, d) => (d.value > best.value ? d : best), data[0]);
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return t('chart.describe', {
    count: data.length,
    total: format(total),
    peak: peak.label,
    value: format(peak.value),
  });
}

export async function BarChart({
  data,
  format = identity,
  hrefFor,
  unit,
}: {
  data: LabelledValue[];
  format?: (value: number) => string;
  hrefFor?: (label: string) => string;
  unit?: string;
}) {
  if (!data.length) return <EmptyChart />;
  const t = await getT();
  const max = niceMax(data.map((d) => d.value));
  const total = data.reduce((sum, d) => sum + d.value, 0);

  return (
    <ul className="bars">
      {data.map((d, index) => {
        const share = total > 0 ? Math.round((d.value / total) * 100) : 0;
        const tip = t('chart.barTip', {
          label: d.label,
          value: `${format(d.value)}${unit ? ` ${unit}` : ''}`,
          share,
        });

        return (
          <li key={d.label} className="bar-row" data-tip={tip}>
            <span className="bar-rank">{index + 1}</span>
            {hrefFor ? (
              <Link className="bar-label" href={hrefFor(d.label)}>
                {d.label}
              </Link>
            ) : (
              <span className="bar-label">{d.label}</span>
            )}
            <span className="bar-track">
              <span
                className="bar-fill"
                style={{ width: `${(d.value / max) * 100}%`, animationDelay: `${index * 40}ms` }}
              />
            </span>
            <span className="bar-value">{format(d.value)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Smooth area chart for continuous series — the shape of a month reads better than 30 bars. */
export async function AreaChart({
  data,
  format = identity,
  labelEvery,
  label,
}: {
  data: LabelledValue[];
  format?: (value: number) => string;
  labelEvery?: number;
  label?: string;
}) {
  if (data.length < 2) return <EmptyChart />;
  const t = await getT();

  const width = 760;
  const height = 200;
  const padBottom = 26;
  const padTop = 10;
  const max = niceMax(data.map((d) => d.value));
  const plot = height - padBottom - padTop;
  const step = width / (data.length - 1);
  const every = labelEvery ?? Math.ceil(data.length / 10);

  const points = data.map((d, index) => ({
    x: index * step,
    y: padTop + plot - (d.value / max) * plot,
  }));

  // Catmull-Rom style smoothing, kept simple: pull each control point halfway.
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    const midX = (previous.x + current.x) / 2;
    path += ` C ${midX} ${previous.y}, ${midX} ${current.y}, ${current.x} ${current.y}`;
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart" role="img">
      <title>{label ?? describe(t, data, format)}</title>
      <defs>
        <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--beam)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--beam)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {[0.25, 0.5, 0.75, 1].map((fraction) => (
        <line
          key={fraction}
          x1="0"
          x2={width}
          y1={padTop + plot - plot * fraction}
          y2={padTop + plot - plot * fraction}
          stroke="var(--line)"
          strokeDasharray="2 6"
        />
      ))}

      <path className="area-fill" d={`${path} L ${width} ${padTop + plot} L 0 ${padTop + plot} Z`} fill="url(#area-fill)" />
      <path className="area-line" d={path} fill="none" stroke="var(--beam)" strokeWidth="2" strokeLinecap="round" />

      {data.map((d, index) => (
        <g key={d.label} className="area-point">
          <rect
            x={index * step - step / 2}
            y={0}
            width={step}
            height={height - padBottom}
            fill="transparent"
            data-tip={`${d.label} · ${format(d.value)}`}
          />
          <circle cx={points[index].x} cy={points[index].y} r="3.5" fill="var(--beam)" pointerEvents="none" />
          {index % every === 0 && (
            <text
              x={points[index].x}
              y={height - 8}
              fill="var(--text-faint)"
              fontSize="10"
              textAnchor="middle"
              pointerEvents="none"
            >
              {d.label.length > 5 ? d.label.slice(5) : d.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/** Vertical columns for categorical series — weekdays, hours of the day. */
export async function ColumnChart({
  data,
  format = identity,
  labelEvery = 1,
  label,
}: {
  data: LabelledValue[];
  format?: (value: number) => string;
  labelEvery?: number;
  label?: string;
}) {
  if (!data.length) return <EmptyChart />;
  const t = await getT();

  // The viewBox grows with the number of categories so that twelve months do not end up
  // as twelve towers, and seven weekdays do not shrink their labels to nothing.
  const width = Math.min(760, Math.max(380, data.length * 58));
  const height = 190;
  const padBottom = 24;
  const max = niceMax(data.map((d) => d.value));
  const slot = width / data.length;
  const barWidth = Math.min(44, Math.max(3, slot * 0.62));
  const plot = height - padBottom - 8;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart columns" role="img">
      <title>{label ?? describe(t, data, format)}</title>
      {[0.5, 1].map((fraction) => (
        <line
          key={fraction}
          x1="0"
          x2={width}
          y1={height - padBottom - plot * fraction}
          y2={height - padBottom - plot * fraction}
          stroke="var(--line)"
          strokeDasharray="2 6"
        />
      ))}
      <line x1="0" y1={height - padBottom} x2={width} y2={height - padBottom} stroke="var(--line-strong)" />

      {data.map((d, index) => {
        const barHeight = Math.max((plot * d.value) / max, d.value > 0 ? 2 : 0);
        return (
          <g key={d.label} className="column" data-tip={`${d.label} · ${format(d.value)}`}>
            <rect x={index * slot} y={0} width={slot} height={height - padBottom} fill="transparent" />
            <rect
              className="column-bar"
              x={index * slot + (slot - barWidth) / 2}
              y={height - padBottom - barHeight}
              width={barWidth}
              height={barHeight}
              rx={Math.min(3, barWidth / 2)}
              style={{ animationDelay: `${index * 18}ms`, transformOrigin: `0 ${height - padBottom}px` }}
              pointerEvents="none"
            />
            {index % labelEvery === 0 && (
              <text
                x={index * slot + slot / 2}
                y={height - 8}
                fill="var(--text-faint)"
                fontSize="10"
                textAnchor="middle"
                pointerEvents="none"
              >
                {d.label.length > 5 ? d.label.slice(5) : d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Several series over the same buckets, stacked. The total per bucket is the height, which
 * is what makes "are transcodes growing, or is everything growing?" answerable at a glance —
 * two separate charts side by side never answer that.
 *
 * Series are separated by intensity down the amber ramp, never by hue: the colour rule
 * holds here too.
 */
export async function StackedColumnChart({
  labels,
  series,
  format = identity,
  labelEvery,
}: {
  labels: string[];
  series: { label: string; values: number[] }[];
  format?: (value: number) => string;
  labelEvery?: number;
}) {
  const totals = labels.map((_, index) =>
    series.reduce((sum, s) => sum + (s.values[index] ?? 0), 0),
  );
  if (!labels.length || !totals.some((value) => value > 0)) return <EmptyChart />;
  const t = await getT();

  const width = 760;
  const height = 200;
  const padBottom = 26;
  const plot = height - padBottom - 10;
  const max = niceMax(totals);
  const slot = width / labels.length;
  const barWidth = Math.min(30, Math.max(2, slot * 0.66));
  const every = labelEvery ?? Math.ceil(labels.length / 12);

  return (
    <>
      <svg viewBox={`0 0 ${width} ${height}`} className="chart columns" role="img">
        <title>
          {t('chart.describeStacked', {
            series: series.map((s) => s.label).join(', '),
            count: labels.length,
            peak: format(Math.max(...totals)),
          })}
        </title>
        {[0.5, 1].map((fraction) => (
          <line
            key={fraction}
            x1="0"
            x2={width}
            y1={height - padBottom - plot * fraction}
            y2={height - padBottom - plot * fraction}
            stroke="var(--line)"
            strokeDasharray="2 6"
          />
        ))}
        <line x1="0" y1={height - padBottom} x2={width} y2={height - padBottom} stroke="var(--line-strong)" />

        {labels.map((label, index) => {
          // Segments are laid out bottom-up, so each one needs the height of everything
          // already stacked underneath it.
          let stacked = 0;
          const tip = `${label} · ${series
            .map((s) => `${s.label} ${format(s.values[index] ?? 0)}`)
            .join(' · ')}`;

          return (
            <g key={label} className="column" data-tip={tip}>
              <rect x={index * slot} y={0} width={slot} height={height - padBottom} fill="transparent" />
              {series.map((s, seriesIndex) => {
                const value = s.values[index] ?? 0;
                const segment = (plot * value) / max;
                const y = height - padBottom - stacked - segment;
                stacked += segment;
                if (value <= 0) return null;
                return (
                  <rect
                    key={s.label}
                    x={index * slot + (slot - barWidth) / 2}
                    y={y}
                    width={barWidth}
                    height={segment}
                    fill={RAMP[seriesIndex % RAMP.length]}
                    pointerEvents="none"
                  />
                );
              })}
              {index % every === 0 && (
                <text
                  x={index * slot + slot / 2}
                  y={height - 8}
                  fill="var(--text-faint)"
                  fontSize="10"
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  {label.length > 5 ? label.slice(5) : label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <ul className="legend">
        {series.map((s, index) => (
          <li key={s.label}>
            <span className="dot" style={{ background: RAMP[index % RAMP.length] }} />
            {s.label}
            <span className="muted"> {format(s.values.reduce((sum, v) => sum + v, 0))}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Donut for a handful of shares. */
export async function DonutChart({
  data,
  format = identity,
  label,
}: {
  data: LabelledValue[];
  format?: (value: number) => string;
  label?: string;
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (!total) return <EmptyChart />;
  const t = await getT();

  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 160 160" className="donut" role="img">
        <title>{label ?? describe(t, data, format)}</title>
        <circle cx="80" cy="80" r={radius} fill="none" stroke="rgba(255,255,255,.04)" strokeWidth="18" />
        <g transform="rotate(-90 80 80)">
          {data.map((d, index) => {
            const length = (d.value / total) * circumference;
            const slice = (
              <circle
                key={d.label}
                className="slice"
                cx="80"
                cy="80"
                r={radius}
                fill="none"
                stroke={RAMP[index % RAMP.length]}
                strokeWidth="18"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                data-tip={`${d.label} · ${format(d.value)} (${Math.round((d.value / total) * 100)}%)`}
              />
            );
            offset += length;
            return slice;
          })}
        </g>
      </svg>
      <ul className="legend">
        {data.map((d, index) => (
          <li key={d.label} data-tip={`${format(d.value)} of ${format(total)}`}>
            <span className="dot" style={{ background: RAMP[index % RAMP.length] }} />
            {d.label}
            <span className="muted"> {Math.round((d.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One heatmap frame. Kept separate so a clickable frame is a real anchor — a span with
 * an onClick would not be reachable by keyboard, and every frame is a drill-down target.
 */
function FrameCell({ href, tip, opacity }: { href?: string; tip: string; opacity: number }) {
  if (!href) return <span className="frame" data-tip={tip} style={{ opacity }} />;
  return <Link className="frame" href={href} data-tip={tip} aria-label={tip} style={{ opacity }} />;
}

/**
 * A year of watching as a strip of film: one frame per day, sprocket holes along the
 * edges. Brighter frames are more exposed — more minutes watched that day.
 */
export function Heatmap({
  data,
  format = identity,
  hrefFor,
}: {
  data: LabelledValue[];
  format?: (value: number) => string;
  /** Makes each day clickable — receives the ISO day of that frame. */
  hrefFor?: (day: string) => string;
}) {
  if (!data.length) return <EmptyChart />;
  const max = niceMax(data.map((d) => d.value));

  const firstWeekday = (new Date(`${data[0].label}T00:00:00Z`).getUTCDay() + 6) % 7;
  const cells: (LabelledValue | null)[] = [...Array<null>(firstWeekday).fill(null), ...data];
  const perforations = Math.ceil(cells.length / 7);

  return (
    <div className="filmstrip">
      <div className="perf" aria-hidden>
        {Array.from({ length: perforations }, (_, index) => (
          <span key={index} />
        ))}
      </div>

      <div className="frames">
        {cells.map((cell, index) =>
          cell === null ? (
            <span key={`blank-${index}`} className="frame blank" />
          ) : (
            <FrameCell
              key={cell.label}
              href={hrefFor && cell.value > 0 ? hrefFor(cell.label) : undefined}
              tip={`${cell.label} · ${format(cell.value)}`}
              opacity={cell.value === 0 ? 0.06 : 0.2 + 0.8 * (cell.value / max)}
            />
          ),
        )}
      </div>

      <div className="perf" aria-hidden>
        {Array.from({ length: perforations }, (_, index) => (
          <span key={index} />
        ))}
      </div>
    </div>
  );
}

/** Weekday × hour grid — shows when in the week someone actually watches. */
export async function WeekHourGrid({
  data,
  format = identity,
  hrefFor,
}: {
  /** 7 × 24 values, Monday first, hour 0 first. */
  data: number[][];
  format?: (value: number) => string;
  /** Makes each cell clickable — receives the weekday index (Monday = 0) and the hour. */
  hrefFor?: (dayIndex: number, hour: number) => string;
}) {
  const flat = data.flat();
  if (!flat.some((value) => value > 0)) return <EmptyChart />;
  const max = niceMax(flat);
  const t = await getT();
  const days = [
    t('weekday.mon'),
    t('weekday.tue'),
    t('weekday.wed'),
    t('weekday.thu'),
    t('weekday.fri'),
    t('weekday.sat'),
    t('weekday.sun'),
  ];

  return (
    <div className="weekgrid-wrap">
      <div className="weekgrid">
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="weekgrid-hour">
            {hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}
          </span>
        ))}
        {days.map((day, dayIndex) => (
          <Fragment key={day}>
            <span className="weekgrid-day">{day}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const value = data[dayIndex][hour] ?? 0;
              const tip = `${day} ${String(hour).padStart(2, '0')}:00 · ${format(value)}`;
              const opacity = value === 0 ? 0.05 : 0.18 + 0.82 * (value / max);
              const href = hrefFor && value > 0 ? hrefFor(dayIndex, hour) : undefined;

              return href ? (
                <Link
                  key={`${day}-${hour}`}
                  className="weekgrid-cell"
                  href={href}
                  data-tip={tip}
                  aria-label={tip}
                  style={{ opacity }}
                />
              ) : (
                <span key={`${day}-${hour}`} className="weekgrid-cell" data-tip={tip} style={{ opacity }} />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
