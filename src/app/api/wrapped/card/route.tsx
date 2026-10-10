import { ImageResponse } from 'next/og';
import { NextResponse } from 'next/server';
import { rateLimit } from '@/server/ratelimit';
import { getServer } from '@/server/config';
import { getSession } from '@/server/session';
import { resolveView } from '@/server/viewscope';
import { globalState } from '@/server/state';
import { getWrapped } from '@/server/wrapped';
import { cardText, parseYear, watchTime } from '@/server/wrapped-story-core';
import { getLocale, getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

// The card is personal and rendered per request; nothing may keep a copy of it.
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Satori knows no CSS variables, so these are the dark theme tokens as literals.
const INK = '#08090b';
const SURFACE = '#101216';
const TEXT = '#e9ebef';
const DIM = '#8a919f';
const AMBER = '#ffb020';
const LINE = 'rgba(255, 255, 255, 0.08)';

// Rendering is CPU-bound and blocks the event loop for 1-3 s, and the story page asks for the
// same card the download link does. A short in-memory copy per person, year and language
// turns repeat requests into a buffer copy; the cap keeps the memory bounded.
const CARD_TTL_MS = 5 * 60_000;
const CARD_CACHE_MAX = 50;
const CARD_LIMIT_PER_MINUTE = 6;
const cache = globalState('wrapped.card', () => new Map<string, { at: number; png: ArrayBuffer }>());

/**
 * The year as a 1080x1350 PNG, for the signed-in user only. A year without plays answers
 * 404 JSON rather than drawing an empty card nobody would want to share.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  if (!rateLimit(`wrapped-card:${session.user.id}`, CARD_LIMIT_PER_MINUTE, 60_000)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: NO_STORE });
  }

  const query = new URL(request.url).searchParams;
  const year = parseYear(query.get('year'));
  const server = await getServer(session.user.serverId);
  if (!server) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  // Personal by default; an admin may ask for a server's year, resolved by the same rule as the page.
  const view = await resolveView(
    { ...session, server },
    { view: query.get('view') ?? undefined, server: query.get('server') ?? undefined },
  );
  const cacheKey = `${session.user.id}:${view.kind}:${view.server.id}:${year}:${await getLocale()}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CARD_TTL_MS) {
    return new Response(hit.png.slice(0), { headers: { ...NO_STORE, 'Content-Type': 'image/png' } });
  }

  const wrapped = await getWrapped(view.scope, year);
  if (wrapped.plays === 0) {
    return NextResponse.json({ error: 'No plays in this year' }, { status: 404, headers: NO_STORE });
  }

  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const time = watchTime(wrapped.watchtimeMs);
  const topTitle = wrapped.topTitles[0];
  const genre = wrapped.topGenres[0];
  // Text is reduced to what the bundled font can draw: anything else makes the renderer fetch
  // fonts and emoji from the internet (leaking the characters) and abort when that fails.
  const username = cardText(view.kind === 'server' ? view.server.label : session.user.username, 40);

  const cells: { label: string; value: string; unit?: string; sub?: { value: string; label: string } }[] = [
    {
      label: t('common.watchTime'),
      value: time ? number(time.value) : '0',
      unit: time ? t(time.unit === 'hours' ? 'story.unit.hours' : 'story.unit.minutes') : undefined,
    },
    { label: t('story.plays.label'), value: number(wrapped.plays) },
    {
      label: t('story.card.topTitle'),
      value: cardText(topTitle.label),
      sub: { value: number(topTitle.plays), label: t('story.plays.label') },
    },
    genre
      ? {
          label: t('story.card.topGenre'),
          value: cardText(genre.label, 40),
          sub: { value: `${wrapped.topGenreShare}%`, label: t('story.genre.share') },
        }
      : { label: t('stats.activeDays'), value: number(wrapped.activeDays) },
  ];

  const image = new ImageResponse(
    (
      <div
        style={{
          width: 1080,
          height: 1350,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          padding: 72,
          background: INK,
          color: TEXT,
          fontFamily: 'Geist',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 1080,
            height: 1350,
            display: 'flex',
            backgroundImage:
              'radial-gradient(circle at 85% 0%, rgba(233, 235, 239, 0.1), rgba(8, 9, 11, 0) 55%), radial-gradient(circle at 0% 100%, rgba(233, 235, 239, 0.06), rgba(8, 9, 11, 0) 55%)',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div
            style={{
              display: 'flex',
              fontSize: 32,
              letterSpacing: 9,
              textTransform: 'uppercase',
              color: TEXT,
            }}
          >
            {t('app.name')}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 26,
              letterSpacing: 6,
              textTransform: 'uppercase',
              color: DIM,
            }}
          >
            {t('story.card.eyebrow')}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 84 }}>
          <div
            style={{
              display: 'flex',
              fontSize: 330,
              lineHeight: 0.86,
              letterSpacing: -14,
              WebkitTextStroke: '5px #e9ebef',
            }}
          >
            {year}
          </div>
          <div style={{ display: 'flex', marginTop: 30, fontSize: 46, color: DIM }}>
            {username}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 24,
            marginTop: 'auto',
          }}
        >
          {cells.map((cell) => (
            <div
              key={cell.label}
              style={{
                width: 456,
                height: 276,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: 36,
                borderRadius: 32,
                background: SURFACE,
                border: `2px solid ${LINE}`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  fontSize: 24,
                  letterSpacing: 5,
                  textTransform: 'uppercase',
                  color: DIM,
                }}
              >
                {cell.label}
              </div>
              {cell.sub ? (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <div
                    style={{
                      // Block, not flex: Satori only clamps lines of a block-level text box.
                      display: 'block',
                      fontSize: 46,
                      lineHeight: 1.1,
                      lineClamp: 2,
                      WebkitTextStroke: '1.2px #e9ebef',
                    }}
                  >
                    {cell.value}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 14 }}>
                    <div
                      style={{
                        display: 'flex',
                        fontSize: 44,
                        color: AMBER,
                        WebkitTextStroke: '1.5px #ffb020',
                      }}
                    >
                      {cell.sub.value}
                    </div>
                    <div style={{ display: 'flex', marginLeft: 14, fontSize: 24, color: DIM }}>
                      {cell.sub.label}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'baseline' }}>
                  <div
                    style={{
                      display: 'flex',
                      fontSize: cell.value.length > 5 ? 110 : 132,
                      lineHeight: 1,
                      letterSpacing: -4,
                      color: AMBER,
                      WebkitTextStroke: '4px #ffb020',
                    }}
                  >
                    {cell.value}
                  </div>
                  {cell.unit && (
                    <div style={{ display: 'flex', marginLeft: 16, fontSize: 30, color: DIM }}>
                      {cell.unit}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 44 }}>
          {[
            { value: number(wrapped.activeDays), label: t('stats.activeDays') },
            { value: number(wrapped.longestStreak), label: t('story.days.streak') },
          ].map((item) => (
            <div key={item.label} style={{ display: 'flex', alignItems: 'baseline' }}>
              <div style={{ display: 'flex', fontSize: 34, color: AMBER }}>{item.value}</div>
              <div
                style={{
                  display: 'flex',
                  marginLeft: 14,
                  fontSize: 22,
                  letterSpacing: 4,
                  textTransform: 'uppercase',
                  color: DIM,
                }}
              >
                {item.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
    { width: 1080, height: 1350, headers: NO_STORE },
  );

  let png: ArrayBuffer;
  try {
    png = await image.arrayBuffer();
  } catch (error) {
    console.error('[watcharr] wrapped card render failed:', error);
    return NextResponse.json({ error: 'The card could not be rendered' }, { status: 500, headers: NO_STORE });
  }

  cache.set(cacheKey, { at: Date.now(), png });
  while (cache.size > CARD_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return new Response(png.slice(0), { headers: { ...NO_STORE, 'Content-Type': 'image/png' } });
}
