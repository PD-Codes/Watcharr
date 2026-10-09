import Link from 'next/link';
import type { ReactNode } from 'react';
import { getAchievements, getInsights } from '@/server/insights';
import type { TranslationKey } from '@/i18n';
import { levelOf } from '@/server/insights-core';
import type { Achievement, AchievementId, Insight } from '@/server/insights-core';
import type { Scope } from '@/server/stats';
import type { Translate } from '@/i18n';
import { getLocale, getT } from '@/i18n/server';
import './insights.css';

interface Ctx {
  t: Translate;
  locale: string;
  /** One viewer's own plays. Server-wide cards cannot open a single user's history. */
  personal: boolean;
}

const titleHref = (title: string, personal: boolean) =>
  `/title/${encodeURIComponent(title)}${personal ? '' : '?scope=server'}`;

// The history page filters on `date`, and only ever for the signed-in user.
const dayHref = (day: string) => `/history?date=${day}`;

const longDate = (day: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );

/** Puts a node where a translated sentence has `{token}`, without splitting the sentence in two strings. */
function around(sentence: string, token: string, node: ReactNode): ReactNode {
  const [before, after = ''] = sentence.split(`{${token}}`);
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

function Card({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <li className="card ins-card">
      <p className="eyebrow">{eyebrow}</p>
      {children}
    </li>
  );
}

/** The strong line: a figure (mono, the highlighted data) and what it is about. */
function Main({ value, children }: { value: string; children?: ReactNode }) {
  return (
    <p className="ins-main">
      <span className="ins-value num">{value}</span>
      {children && <span className="ins-label">{children}</span>}
    </p>
  );
}

function InsightCard({ insight, ctx }: { insight: Insight; ctx: Ctx }) {
  const { t, locale, personal } = ctx;
  const number = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  switch (insight.kind) {
    case 'onThisDay':
      return (
        <Card eyebrow={t('ins.eyebrow.onThisDay')}>
          <ul className="ins-years">
            {insight.entries.map((entry) => (
              <li key={entry.year}>
                <Link
                  prefetch={false}
                  href={personal ? dayHref(entry.day) : titleHref(entry.linkTitle, false)}
                >
                  <span className="ins-value num">{entry.year}</span>
                  <span className="ins-label">{entry.name}</span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="ins-text">{t('ins.onThisDay.text')}</p>
        </Card>
      );

    case 'binge': {
      const date = longDate(insight.day, locale);
      return (
        <Card eyebrow={t('ins.eyebrow.binge')}>
          <p className="ins-main">
            <Link prefetch={false} className="ins-link" href={titleHref(insight.show, personal)}>
              <span className="ins-value num">{insight.episodes}×</span>
              <span className="ins-label">{insight.show}</span>
            </Link>
          </p>
          <p className="ins-text">
            {around(
              t('ins.binge.text', { date: '{date}' }),
              'date',
              personal ? (
                <Link prefetch={false} className="ins-inline" href={dayHref(insight.day)}>
                  {date}
                </Link>
              ) : (
                date
              ),
            )}
          </p>
        </Card>
      );
    }

    case 'comfort':
      return (
        <Card eyebrow={t('ins.eyebrow.comfort')}>
          <p className="ins-main">
            <Link prefetch={false} className="ins-link" href={titleHref(insight.linkTitle, personal)}>
              <span className="ins-value num">{insight.count}×</span>
              <span className="ins-label">{insight.name}</span>
            </Link>
          </p>
          <p className="ins-text">{t('ins.comfort.text')}</p>
        </Card>
      );

    case 'chronotype':
      return (
        <Card eyebrow={t('ins.eyebrow.chronotype')}>
          <Main value={`${Math.round(insight.share * 100)}%`}>{t(`ins.chrono.${insight.type}.label`)}</Main>
          <p className="ins-text">{t(`ins.chrono.${insight.type}.text`)}</p>
        </Card>
      );

    case 'weekend':
      return (
        <Card eyebrow={t('ins.eyebrow.weekend')}>
          <Main value={`${number.format(insight.ratio)}×`}>{t(`ins.weekend.${insight.side}.label`)}</Main>
          <p className="ins-text">{t(`ins.weekend.${insight.side}.text`, { ratio: number.format(insight.ratio) })}</p>
        </Card>
      );

    case 'momentum': {
      const sign = insight.changePct > 0 ? '+' : insight.changePct < 0 ? '−' : '±';
      return (
        <Card eyebrow={t('ins.eyebrow.momentum')}>
          <Main value={`${sign}${Math.abs(insight.changePct)}%`}>{t('ins.momentum.label')}</Main>
          <p className="ins-text">
            {t('ins.momentum.text', { current: insight.current, previous: insight.previous })}
          </p>
        </Card>
      );
    }
  }
}

/**
 * A handful of true observations about the watching, or nothing at all: a card with too little
 * behind it is left out rather than padded, so a new account sees no strip.
 */
export async function InsightsStrip({ scope }: { scope: Scope }) {
  const insights = await getInsights(scope);
  if (insights.length === 0) return null;
  const t = await getT();
  const ctx: Ctx = { t, locale: await getLocale(), personal: scope.userId !== null };

  return (
    <section className="section ins-strip" aria-labelledby="ins-strip-title">
      <h2 id="ins-strip-title">{t('ins.stripTitle')}</h2>
      <ul className="ins-grid">
        {insights.map((insight) => (
          <InsightCard key={insight.kind} insight={insight} ctx={ctx} />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------------------------

// 24x24, stroked, round caps: the same hand as Icons.tsx. Neutral graphite, never a hue.
const GLYPHS: Record<AchievementId, ReactNode> = {
  // Added later, same hand: a screen, a stack of screens, a ticket stub and so on.
  seriesFan: (
    <>
      <rect x="3.5" y="5" width="17" height="11.5" rx="2" />
      <path d="M8.5 20h7M12 16.5V20" />
    </>
  ),
  deepDive: <path d="M3 9c3-3 6 3 9 0s6 3 9 0M3 14c3-3 6 3 9 0s6 3 9 0M3 19c3-3 6 3 9 0s6 3 9 0" />,
  tripleFeature: (
    <>
      <rect x="3" y="9" width="10" height="11" rx="1.8" />
      <path d="M6 6h10a2 2 0 0 1 2 2M9 3h10a2 2 0 0 1 2 2v9" />
    </>
  ),
  busyDay: <path d="M4 20V12M9 20V6M14 20V9M19 20V4" />,
  weeklyHabit: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M8 3.5v3M16 3.5v3M8 14h2M12 14h2M16 14h.01" />
    </>
  ),
  classics: <path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.5 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z" />,
  lunchBreak: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
  festive: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />,
  leapDay: <path d="M5 9a3.5 3.5 0 0 1 7 0v10M5 19h14M12 14h6" />,
  plays: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10 8.8v6.4l5.2-3.2z" />
    </>
  ),
  hours: <path d="M7 4h10M7 20h10M8 4c0 4.5 4 5.5 4 8s-4 3.5-4 8M16 4c0 4.5-4 5.5-4 8s4 3.5 4 8" />,
  regular: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
      <path d="M4 10h16M8 3.5v4M16 3.5v4M9.2 15l2 2 3.6-3.8" />
    </>
  ),
  streak: <path d="M12.5 3c.6 3.2 4.5 4.8 4.5 9.6A5 5 0 0 1 7 13c0-1.8.9-3.2 2-4 .1 1.6.8 2.5 1.8 2.8C10.5 8.7 11 5.5 12.5 3z" />,
  binge: <path d="m4 8.5 8-4 8 4-8 4zM4 12.5l8 4 8-4M4 16.5l8 4 8-4" />,
  marathoner: (
    <>
      <circle cx="12" cy="13.5" r="7" />
      <path d="M12 9.5v4l2.6 1.6M9.5 3h5" />
    </>
  ),
  rewatcher: <path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19l-3-3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5l3 3" />,
  cinephile: (
    <>
      <rect x="4" y="10" width="16" height="10" rx="1.5" />
      <path d="m4.4 9.6-.8-4 15 3 .8 1M8.2 6.6l1.6 3.2M13.2 7.6l1.6 3.2" />
    </>
  ),
  explorer: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15.8 8.2-2.1 5.5-5.5 2.1 2.1-5.5z" />
    </>
  ),
  nightOwl: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5zM17 4v3M15.5 5.5h3" />,
  earlyBird: <path d="M3 18.5h18M7 18.5a5 5 0 0 1 10 0M12 5v3M5.2 9.2l2 2M18.8 9.2l-2 2" />,
  weekendWarrior: <path d="M5.5 11V8a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3M3 13.5a2 2 0 0 1 4 0V15h10v-1.5a2 2 0 0 1 4 0V19H3zM6.5 19v1.5M17.5 19v1.5" />,
  doubleFeature: (
    <>
      <rect x="3.5" y="8" width="12.5" height="11.5" rx="2" />
      <path d="M8 4.5h10.5a2 2 0 0 1 2 2V16" />
    </>
  ),
  timeTraveler: <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.2h4.2M12 8v4.2l3 1.8" />,
  friday13: (
    <>
      <path d="M6 20.5v-9.2a6 6 0 0 1 12 0v9.2l-2.2-1.6-1.9 1.6-1.9-1.6-1.9 1.6-1.9-1.6z" />
      <path d="M9.8 11h.01M14.2 11h.01" />
    </>
  ),
};

/** One ring segment per tier, filled for the tiers reached. */
function Ring({ tiers, tier }: { tiers: number; tier: number }) {
  const R = 29;
  const C = 32;
  if (tiers === 1) {
    return <circle cx={C} cy={C} r={R} className={tier >= 1 ? 'on' : undefined} />;
  }
  const gap = 0.16; // radians between segments
  const step = (Math.PI * 2) / tiers;
  const point = (angle: number) => `${(C + R * Math.sin(angle)).toFixed(2)} ${(C - R * Math.cos(angle)).toFixed(2)}`;
  return (
    <>
      {Array.from({ length: tiers }, (_, i) => {
        const from = i * step + gap / 2;
        const to = (i + 1) * step - gap / 2;
        return (
          <path
            key={i}
            d={`M${point(from)}A${R} ${R} 0 0 1 ${point(to)}`}
            className={i < tier ? 'on' : undefined}
          />
        );
      })}
    </>
  );
}

function Badge({ a, t }: { a: Achievement; t: Translate }) {
  const maxed = a.tier === a.tiers;
  const caption = !a.unlocked
    ? t('ins.badgeLocked')
    : a.tiers === 1
      ? t('ins.badgeEarned')
      : t('ins.badgeTier', { tier: a.tier, tiers: a.tiers });
  const shown = Math.min(Math.floor(a.value), a.target);
  const name = a.custom ? a.custom.name : t(`ins.ach.${a.id}.name` as TranslationKey);
  const goal = a.custom
    ? a.custom.description || t('ins.customGoal', { count: a.target })
    : t(`ins.ach.${a.id}.goal` as TranslationKey, { count: a.target });

  return (
    <li className={`ins-badge${a.unlocked ? ' on' : ''}`}>
      <span className="ins-medal" aria-hidden>
        <svg className="ins-ring" viewBox="0 0 64 64">
          <Ring tiers={a.tiers} tier={a.tier} />
        </svg>
        {a.custom ? (
          <span className="ins-emoji">{a.custom.icon}</span>
        ) : (
          <svg
            className="ins-glyph"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            focusable="false"
          >
            {GLYPHS[a.id as AchievementId]}
          </svg>
        )}
      </span>
      <span className="ins-badge-name">{name}</span>
      <span className="ins-badge-caption">{caption}</span>
      <span className="ins-badge-goal">{goal}</span>
      {!maxed && (
        <>
          <span
            className="ins-meter"
            role="progressbar"
            aria-label={name}
            aria-valuemin={0}
            aria-valuemax={a.target}
            aria-valuenow={shown}
          >
            <span style={{ width: `${Math.round(a.progress * 100)}%` }} />
          </span>
          <span className="ins-badge-count num">
            {shown} / {a.target}
          </span>
        </>
      )}
    </li>
  );
}

/**
 * Every badge, earned ones first and the nearest unearned ones after them. The caller owns the
 * h2 above it. Locked badges stay on the shelf with their progress; hiding them would turn
 * the shelf into a list of what you already know.
 */
export async function BadgeShelf({ scope }: { scope: Scope }) {
  const [achievements, t] = await Promise.all([getAchievements(scope), getT()]);
  // Array.sort is stable, so equal rows keep the table's order.
  const ordered = [...achievements].sort(
    (a, b) => Number(b.unlocked) - Number(a.unlocked) || (a.unlocked ? 0 : b.progress - a.progress),
  );
  const done = achievements.filter((a) => a.unlocked).length;
  const level = levelOf(achievements);
  // The unfinished badge that is furthest along: the one worth going for next.
  const next = achievements
    .filter((a) => a.tier < a.tiers && a.progress > 0)
    .sort((a, b) => b.progress - a.progress)[0];
  const nextName = next ? (next.custom ? next.custom.name : t(`ins.ach.${next.id}.name` as TranslationKey)) : null;

  return (
    <div className="ins-shelf">
      <div className="ins-level">
        <strong>{t('ins.level', { level: level.level, title: t(`ins.level.${level.level}` as TranslationKey) })}</strong>
        <span className="muted num">
          {level.to === null
            ? t('ins.levelMax', { xp: level.xp })
            : t('ins.levelNext', { xp: level.xp, to: level.to })}
        </span>
        <span
          className="ins-meter"
          role="progressbar"
          aria-label={t('ins.levelLabel')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level.progress * 100)}
        >
          <span style={{ width: `${Math.round(level.progress * 100)}%` }} />
        </span>
      </div>
      <p className="muted ins-shelf-sum">
        {t('ins.shelfSummary', { done, total: achievements.length })}
        {nextName && ` · ${t('ins.nextUp', { name: nextName, percent: Math.round(next.progress * 100) })}`}
      </p>
      <ul className="ins-badges">
        {ordered.map((a) => (
          <Badge key={a.id} a={a} t={t} />
        ))}
      </ul>
    </div>
  );
}
