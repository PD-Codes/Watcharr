'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '@/components/Icons';
import Poster from '@/components/Poster';
import { artUrl, formatDuration, formatTimecode } from '@/components/format';
import { useT } from '@/i18n/client';
import {
  SLIDE_MS,
  clockParts,
  driftOffset,
  idleDim,
  nextSlide,
  positionAt,
  reconcileClock,
  relativeAge,
  type ScreenSlide,
  type ScreenStats,
  type ScreenStream,
  type StreamClock,
} from '@/server/screen-core';
import './screen.css';

/** Secondary streams that get a card; the rest are counted, not drawn. */
const MAX_OTHERS = 4;
/** Controls stay on screen this long after the last pointer or key activity. */
const CONTROLS_MS = 3_000;
/** The "Press F" hint is a hint for the first seconds, not furniture. */
const HINT_MS = 12_000;

/** Wall-clock time in ms, or null until mounted: the server's clock and zone are not the display's. */
function useNow(intervalMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Eases a number up to its target; a value that stays the same does not restart. */
function useCountUp(target: number, ms = 1400): number {
  const [value, setValue] = useState(target);
  const shown = useRef(target);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      shown.current = target;
      setValue(target);
      return;
    }
    const from = shown.current;
    const started = performance.now();
    let frame = 0;
    const step = (at: number) => {
      const k = Math.min(1, (at - started) / ms);
      shown.current = from + (target - from) * (1 - Math.pow(1 - k, 3));
      setValue(shown.current);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return Math.round(value);
}

/**
 * A playhead that keeps moving between refreshes. The server sends where the stream is as
 * of the render; this pins that to the display's own clock and runs it forward, taking a
 * fresh value only when it disagrees (see reconcileClock) so the timecode never ticks back.
 */
function usePlayhead(stream: ScreenStream) {
  const [clock, setClock] = useState<StreamClock | null>(null);
  const now = useNow(250);

  useEffect(() => {
    const at = Date.now();
    setClock((prev) =>
      reconcileClock(
        prev ?? undefined,
        { positionMs: stream.positionMs, playing: stream.advancing, durationMs: stream.durationMs },
        at,
      ),
    );
  }, [stream.positionMs, stream.advancing, stream.durationMs]);

  const position = clock && now !== null ? positionAt(clock, now) : stream.positionMs;
  return { position, now };
}

function Clock({ locale }: { locale: string }) {
  const now = useNow(1000);
  if (now === null) return <div className="scr-clock" aria-hidden />;
  const { time, period, date } = clockParts(now, locale);
  return (
    <time className="scr-clock" dateTime={new Date(now).toISOString()}>
      <span className="scr-time num">
        {time}
        {period && <span className="scr-period">{period}</span>}
      </span>
      <span className="scr-date">{date}</span>
    </time>
  );
}

/** The scrub line. Fill and head share one custom property so they cannot drift apart. */
function Scrub({ fraction, running }: { fraction: number; running: boolean }) {
  return (
    <div
      className="scr-scrub"
      data-running={running ? '1' : undefined}
      style={{ '--p': Math.min(1, Math.max(0, fraction)) } as CSSProperties}
      aria-hidden
    >
      <span className="scr-fill" />
      <span className="scr-rail">
        <span className="scr-head" />
      </span>
    </div>
  );
}

const left = (ms: number) => (ms < 60_000 ? '<1m' : formatDuration(ms));

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen().catch(() => {});
}

function Hero({
  stream,
  serverSlug,
  locale,
}: {
  stream: ScreenStream;
  serverSlug: string;
  locale: string;
}) {
  const t = useT();
  const { position, now } = usePlayhead(stream);
  const playing = stream.state === 'playing';
  const known = stream.durationMs > 0;
  const remaining = Math.max(0, stream.durationMs - position);
  const fraction = known ? position / stream.durationMs : 0;

  // "Ends at" only means something while the film runs; a pause has no end time.
  let endsAt: string | null = null;
  if (playing && known && now !== null) {
    const { time, period } = clockParts(now + remaining, locale);
    endsAt = t('screen.endsAt', { time: period ? `${time} ${period}` : time });
  }

  const facts = [
    stream.user ? { label: t('screen.watching'), value: stream.user } : null,
    now !== null ? { label: t('screen.started'), value: relativeAge(stream.startedAt, now, locale) } : null,
    stream.device ? { label: t('common.device'), value: stream.device } : null,
    stream.client ? { label: t('screen.player'), value: stream.client } : null,
  ].filter((fact): fact is { label: string; value: string } => fact !== null);

  return (
    <article className="scr-hero" data-state={stream.state}>
      <div className="scr-poster-box">
        <Poster
          key={stream.itemId}
          className="scr-poster"
          src={artUrl(serverSlug, stream.itemId)}
          label={stream.title}
          loading="eager"
        />
      </div>

      <div className="scr-info">
        <p className="scr-kicker">
          <span className={`badge ${playing ? 'live' : ''}`}>
            {stream.state === 'paused' ? t('beam.paused') : t('beam.nowPlaying')}
          </span>
          {playing && (
            <span className="scr-eq" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          )}
        </p>
        <h2 className="scr-title">{stream.title}</h2>
        {stream.episode && <p className="scr-episode">{stream.episode}</p>}

        {facts.length > 0 && (
          <dl className="scr-facts">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="scr-progress">
          <Scrub fraction={fraction} running={playing} />
          <div className="scr-readout">
            <span className="scr-timecode num">
              {formatTimecode(position)}
              {known && <span className="scr-total"> / {formatTimecode(stream.durationMs)}</span>}
            </span>
            {known && (
              <span className="scr-left">
                {t('beam.remaining', { duration: left(remaining) })}
                {endsAt && <span className="scr-ends"> · {endsAt}</span>}
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function Mini({ stream, serverSlug }: { stream: ScreenStream; serverSlug: string }) {
  const t = useT();
  const { position } = usePlayhead(stream);
  const remaining = Math.max(0, stream.durationMs - position);
  const playing = stream.state === 'playing';
  const who = [stream.user, stream.device].filter(Boolean).join(' · ');

  return (
    <li className="scr-mini" data-state={stream.state}>
      <Poster
        key={stream.itemId}
        className="scr-mini-art"
        src={artUrl(serverSlug, stream.itemId)}
        label={stream.title}
        loading="eager"
      />
      <div className="scr-mini-body">
        <p className="scr-mini-title">{stream.title}</p>
        <p className="scr-mini-sub">
          {stream.episode ?? (who || '\u00a0')}
        </p>
        {stream.episode && who && <p className="scr-mini-sub">{who}</p>}
        <Scrub fraction={stream.durationMs > 0 ? position / stream.durationMs : 0} running={playing} />
        <p className="scr-mini-meta">
          <span className={`badge ${playing ? 'live' : ''}`}>
            {stream.state === 'paused' ? t('beam.paused') : t('beam.nowPlaying')}
          </span>
          {stream.durationMs > 0 && <span className="num">{t('beam.remaining', { duration: left(remaining) })}</span>}
        </p>
      </div>
    </li>
  );
}

/** Which slide is up, and which one is still fading out (its zoom must not snap back). */
function useSlideshow(count: number) {
  const [state, setState] = useState<{ index: number; prev: number | null }>({ index: 0, prev: null });

  useEffect(() => {
    if (count < 2) return;
    const timer = setInterval(
      () => setState((s) => ({ index: nextSlide(s.index, count), prev: s.index })),
      SLIDE_MS,
    );
    return () => clearInterval(timer);
  }, [count]);

  const index = state.index < count ? state.index : 0;
  const prev = state.prev !== null && state.prev < count && state.prev !== index ? state.prev : null;
  return (i: number) => (i === index ? 'on' : i === prev ? 'prev' : '');
}

function Stats({ stats }: { stats: ScreenStats }) {
  const t = useT();
  const plays = useCountUp(stats.plays);
  const watchMs = useCountUp(stats.watchMs);
  const streak = useCountUp(stats.streak);
  return (
    <dl className="scr-stats">
      <div>
        <dt>{t('screen.statPlays')}</dt>
        <dd className="num">{plays}</dd>
      </div>
      <div>
        <dt>{t('screen.statTime')}</dt>
        <dd className="num">{formatDuration(watchMs)}</dd>
      </div>
      <div>
        <dt>{t('dash.kpiStreak')}</dt>
        <dd className="num">{streak}</dd>
      </div>
    </dl>
  );
}

function Intermission({
  slides,
  stats,
  serverSlug,
  slideClass,
}: {
  slides: ScreenSlide[];
  stats: ScreenStats | null;
  serverSlug: string;
  slideClass: (i: number) => string;
}) {
  const t = useT();
  return (
    <>
      <div className="scr-slides">
        {slides.length === 0 && (
          <div className="scr-empty">
            <span className="bulb" />
            <p>{t('dash.heroIdle')}</p>
          </div>
        )}
        {slides.map((slide, i) => {
          const cls = slideClass(i);
          return (
            <figure key={slide.key} className={`scr-slide ${cls}`} aria-hidden={cls !== 'on'}>
              <div className="scr-poster-box">
                <Poster
                  className="scr-poster scr-kb"
                  src={artUrl(serverSlug, slide.itemId)}
                  fallback={slide.fallback ?? undefined}
                  label={slide.title}
                  loading="eager"
                />
              </div>
              <figcaption className="scr-info">
                <p className="scr-kicker">
                  {t('screen.intermission')}
                  <span aria-hidden> · </span>
                  {slide.kind === 'added' ? t('screen.kindAdded') : t('screen.kindWatched')}
                </p>
                <h2 className="scr-title">{slide.title}</h2>
                <p className="scr-episode">
                  {[slide.year, slide.meta].filter(Boolean).join(' · ')}
                </p>
              </figcaption>
            </figure>
          );
        })}
      </div>

      {slides.length > 1 && (
        <ol className="scr-dots" aria-hidden style={{ '--slide-ms': `${SLIDE_MS}ms` } as CSSProperties}>
          {slides.map((slide, i) => (
            <li key={slide.key} data-on={slideClass(i) === 'on' ? '1' : undefined} />
          ))}
        </ol>
      )}

      {stats && <Stats stats={stats} />}
    </>
  );
}

export default function ScreenClient({
  locale,
  serverSlug,
  streams,
  slides,
  stats,
}: {
  locale: string;
  serverSlug: string;
  streams: ScreenStream[];
  slides: ScreenSlide[];
  stats: ScreenStats | null;
}) {
  const t = useT();
  const hero = streams[0] ?? null;
  const others = streams.slice(1, 1 + MAX_OTHERS);
  const hidden = Math.max(0, streams.length - 1 - others.length);
  const live = hero !== null;
  const slideClass = useSlideshow(live ? 0 : slides.length);

  const stageRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const idleSince = useRef<number | null>(null);
  const [controls, setControls] = useState(false);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [fullscreen, setFullscreen] = useState(false);
  // null until mounted: what the browser can do is unknown to the server.
  const [can, setCan] = useState<{ fullscreen: boolean; wakeLock: boolean; keyboard: boolean } | null>(null);
  const [hint, setHint] = useState(true);

  // Burn-in care, on one slow tick: drift the layout, and dim after ten minutes without a
  // stream. Written straight to the elements so a once-a-second change never re-renders.
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
    idleSince.current = live ? null : (idleSince.current ?? Date.now());
  }, [live]);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const tick = () => {
      const at = Date.now();
      const stage = stageRef.current;
      if (stage) {
        const { x, y } = driftOffset(at);
        stage.style.transform = reduced.matches ? '' : `translate(${x}px, ${y}px)`;
      }
      const dim = dimRef.current;
      if (dim) dim.style.opacity = String(Math.round((1 - idleDim(idleSince.current, at)) * 1000) / 1000);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  // What this browser can do, and the screen-awake request. Both are optional niceties:
  // a display that cannot go fullscreen or hold a wake lock still shows everything.
  useEffect(() => {
    setCan({
      fullscreen: Boolean(document.fullscreenEnabled),
      wakeLock: 'wakeLock' in navigator,
      keyboard: window.matchMedia('(hover: hover) and (pointer: fine)').matches,
    });
    const hintTimer = setTimeout(() => setHint(false), HINT_MS);

    let lock: WakeLockSentinel | null = null;
    let closed = false;
    const acquire = async () => {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      try {
        const next = await navigator.wakeLock.request('screen');
        if (closed) void next.release().catch(() => {});
        else lock = next;
      } catch {
        // Refused (battery saver, no permission): the display just may sleep.
      }
    };
    void acquire();
    // The lock is dropped whenever the tab is hidden, so it has to be asked for again.
    document.addEventListener('visibilitychange', acquire);

    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreen);
    onFullscreen();

    return () => {
      closed = true;
      clearTimeout(hintTimer);
      document.removeEventListener('visibilitychange', acquire);
      document.removeEventListener('fullscreenchange', onFullscreen);
      void lock?.release().catch(() => {});
    };
  }, []);

  const wake = useCallback(() => {
    setControls(true);
    clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setControls(false), CONTROLS_MS);
  }, []);
  useEffect(() => () => clearTimeout(controlsTimer.current), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      wake();
      const typing = (event.target as HTMLElement | null)?.matches?.('input, textarea, select, [contenteditable]');
      if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey && !typing) {
        toggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wake]);

  return (
    <section
      className="scr"
      aria-label={t('screen.title')}
      data-mode={live ? 'live' : 'idle'}
      data-playing={hero?.state === 'playing' ? '1' : undefined}
      data-controls={controls ? '1' : undefined}
      onPointerMove={wake}
      onPointerDown={wake}
    >
      <div className="scr-bg" aria-hidden>
        {hero ? (
          <Poster
            key={hero.itemId}
            className="scr-bg-img"
            src={artUrl(serverSlug, hero.itemId)}
            loading="eager"
          />
        ) : (
          slides.map((slide, i) => (
            <div key={slide.key} className={`scr-bg-slide ${slideClass(i)}`}>
              <Poster
                className="scr-bg-img"
                src={artUrl(serverSlug, slide.itemId)}
                fallback={slide.fallback ?? undefined}
                loading="eager"
              />
            </div>
          ))
        )}
      </div>
      <div className="scr-shade" aria-hidden />
      {hero?.state === 'playing' && (
        <div className="scr-dust" aria-hidden>
          {Array.from({ length: 14 }, (_, i) => (
            <i
              key={i}
              style={
                {
                  '--x': `${(i * 37) % 58 + 4}%`,
                  '--s': `${1 + (i % 3)}`,
                  '--d': `${14 + ((i * 5) % 11)}s`,
                  '--o': `${-((i * 7) % 17)}s`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}

      <div
        className="scr-stage"
        ref={stageRef}
        data-footer={live ? (others.length > 0 || hidden > 0 ? '1' : '0') : stats ? '1' : '0'}
      >
        <header className="scr-top">
          <div className="scr-brand">
            <span className={`bulb ${hero?.state === 'playing' ? 'on' : ''}`} />
            <span>{t('app.name')}</span>
          </div>
          <Clock locale={locale} />
        </header>

        {hero ? (
          <>
            <Hero key={hero.key} stream={hero} serverSlug={serverSlug} locale={locale} />
            {(others.length > 0 || hidden > 0) && (
              <ul className="scr-others">
                {others.map((stream) => (
                  <Mini key={stream.key} stream={stream} serverSlug={serverSlug} />
                ))}
                {hidden > 0 && (
                  <li className="scr-more">{t('dash.heroMore', { count: hidden })}</li>
                )}
              </ul>
            )}
          </>
        ) : (
          <Intermission slides={slides} stats={stats} serverSlug={serverSlug} slideClass={slideClass} />
        )}
      </div>

      <div className="scr-dim" ref={dimRef} aria-hidden />

      <div className="scr-controls">
        {can?.fullscreen && (
          <button
            type="button"
            className="icon-btn"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? t('screen.exitFullscreen') : t('screen.enterFullscreen')}
            aria-pressed={fullscreen}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
              {fullscreen ? (
                <path d="M9 4v4a1 1 0 0 1-1 1H4M15 4v4a1 1 0 0 0 1 1h4M9 20v-4a1 1 0 0 0-1-1H4M15 20v-4a1 1 0 0 1 1-1h4" />
              ) : (
                <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
              )}
            </svg>
          </button>
        )}
        <Link href="/" className="icon-btn" aria-label={t('screen.leave')}>
          <Icon name="close" />
        </Link>
      </div>

      {can && can.keyboard && can.fullscreen && !fullscreen && (
        <p className="scr-hint" data-show={hint ? '1' : undefined}>
          {t('screen.hint')}
          {can.wakeLock && ` · ${t('screen.hintAwake')}`}
        </p>
      )}
    </section>
  );
}
