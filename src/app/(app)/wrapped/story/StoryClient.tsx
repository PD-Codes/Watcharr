'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Icon } from '@/components/Icons';
import Poster from '@/components/Poster';
import { formatMinutes } from '@/components/format';
import { useLocale, useT } from '@/i18n/client';
import type { TranslationKey, Translate } from '@/i18n';
import type { Slide, StoryTitle } from '@/server/wrapped-story-core';
import './story.css';

/**
 * Who the story talks to. A server's year reuses every slide, but "you watched" would be wrong
 * for it: the lines that address the reader have a `story.server.*` twin, and only those swap.
 */
const Voice = createContext<'me' | 'server'>('me');
const SERVER_VOICE = new Set([
  'story.intro.eyebrow',
  'story.intro.name',
  'story.time.eyebrow',
  'story.plays.eyebrow',
  'story.top.eyebrow',
  'story.genre.eyebrow',
  'story.genre.share',
  'story.days.eyebrow',
  'story.when.eyebrow',
  'story.outro.preview',
]);

function useStoryT(): Translate {
  const t = useT();
  const voice = useContext(Voice);
  if (voice === 'me') return t;
  return ((key, vars) =>
    t((SERVER_VOICE.has(key) ? key.replace('story.', 'story.server.') : key) as TranslationKey, vars)) as Translate;
}

const SLIDE_MS = 6000;
const HOLD_MS = 180;
const SWIPE_PX = 48;
const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Server snapshot is "reduced", so the first paint never promises motion it may not keep. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(MOTION_QUERY);
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia(MOTION_QUERY).matches,
    () => true,
  );
}

interface Card {
  preview: string | null;
  file: File | null;
  /** Where the card is drawn: the personal year or a server's, same query as the page. */
  src: string;
}

/**
 * Fetches the share card once, a few slides before it is needed: rendering it takes a moment,
 * and the closing slide should not open on an empty frame. The one blob serves the preview and
 * the share sheet, which needs the bytes ready inside the tap.
 */
function useCard(src: string, year: number, armed: boolean): Card {
  const [card, setCard] = useState<Omit<Card, 'src'>>({ preview: null, file: null });

  useEffect(() => {
    if (!armed) return;
    let cancelled = false;
    let url: string | null = null;
    fetch(src, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error('card'))))
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setCard({ preview: url, file: new File([blob], `watcharr-${year}.png`, { type: 'image/png' }) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [armed, src, year]);

  return { ...card, src };
}

export default function StoryClient({
  slides,
  year,
  query,
  voice = 'me',
}: {
  slides: Slide[];
  year: number;
  query: string;
  voice?: 'me' | 'server';
}) {
  return (
    <Voice.Provider value={voice}>
      <Story slides={slides} year={year} query={query} />
    </Voice.Provider>
  );
}

function Story({ slides, year, query }: { slides: Slide[]; year: number; query: string }) {
  const t = useStoryT();
  const router = useRouter();
  const reduced = useReducedMotion();
  const total = slides.length;
  const reportHref = `/wrapped${query}`;

  const [index, setIndex] = useState(0);
  const [leaving, setLeaving] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [holding, setHolding] = useState(false);
  const [hidden, setHidden] = useState(false);

  // Sticky: stepping back from the end must not throw the card away.
  const [armed, setArmed] = useState(false);
  const card = useCard(`/api/wrapped/card${query}`, year, armed);

  const indexRef = useRef(0);
  const elapsed = useRef(0);
  const fill = useRef<HTMLSpanElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const goTo = useCallback(
    (to: number) => {
      const target = Math.max(0, Math.min(total - 1, to));
      elapsed.current = 0;
      // The bar being left was driven by hand; park it where React will expect it. Going
      // back (or restarting the first slide) empties it, going on fills it.
      fill.current?.style.setProperty('transform', target > indexRef.current ? 'scaleX(1)' : 'scaleX(0)');
      if (target === indexRef.current) return;
      setLeaving(indexRef.current);
      indexRef.current = target;
      setIndex(target);
    },
    [total],
  );

  const last = index === total - 1;
  useEffect(() => {
    if (index >= total - 3) setArmed(true);
  }, [index, total]);
  const running = !reduced && !paused && !holding && !hidden && !last;

  // Auto-advance. The bar is driven here, not by a CSS animation, so pause, hold and a
  // hidden tab all keep the exact same position without two clocks to keep in sync.
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      elapsed.current += now - previous;
      previous = now;
      const progress = Math.min(1, elapsed.current / SLIDE_MS);
      fill.current?.style.setProperty('transform', `scaleX(${progress})`);
      if (progress >= 1) {
        goTo(indexRef.current + 1);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, index, goTo]);

  // The outgoing slide stays mounted just long enough to fade.
  useEffect(() => {
    if (leaving === null) return;
    const id = window.setTimeout(() => setLeaving(null), 260);
    return () => window.clearTimeout(id);
  }, [leaving]);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  // Keyboard. A focused button keeps Space/Enter for itself; arrows work everywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const node = root.current;
      if (!node) return;
      // The palette or the shortcut help opened over the story owns the keyboard.
      const other = Array.from(
        document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]'),
      ).some((el) => el !== node && !node.contains(el));
      if (other) return;
      const active = document.activeElement as HTMLElement | null;

      if (event.key === 'Tab') {
        // Keep Tab inside the layer: the shell behind it is covered, not removed.
        const stops = Array.from(
          node.querySelectorAll<HTMLElement>('a[href], button:not([disabled]):not([tabindex="-1"])'),
        ).filter((stop) => stop.getClientRects().length > 0); // the side arrows are display:none on phones
        if (stops.length === 0) return;
        const first = stops[0];
        const end = stops[stops.length - 1];
        const inside = active ? node.contains(active) : false;
        if (!inside || (event.shiftKey && (active === first || active === node))) {
          event.preventDefault();
          (event.shiftKey ? end : first).focus();
        } else if (!event.shiftKey && active === end) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goTo(indexRef.current + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goTo(indexRef.current - 1);
      } else if (event.key === ' ' && !active?.closest('a, button, input, select, textarea')) {
        event.preventDefault();
        goTo(indexRef.current + 1);
      } else if (event.key === 'Escape') {
        router.push(reportHref);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, router, reportHref]);

  // Pointer: hold pauses, a horizontal drag swipes, a short press falls through to the
  // zone buttons underneath. After a hold or a swipe the click that follows is swallowed.
  const press = useRef({ active: false, x: 0, y: 0, held: false, timer: 0 });
  const swallowClick = useRef(false);

  const onPointerDown = (event: ReactPointerEvent) => {
    if ((event.target as HTMLElement).closest('[data-story-ui]')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const state = press.current;
    window.clearTimeout(state.timer);
    swallowClick.current = false;
    Object.assign(state, { active: true, x: event.clientX, y: event.clientY, held: false });
    state.timer = window.setTimeout(() => {
      state.held = true;
      setHolding(true);
    }, HOLD_MS);
  };

  useEffect(() => {
    const end = (event: PointerEvent) => {
      const state = press.current;
      if (!state.active) return;
      state.active = false;
      window.clearTimeout(state.timer);
      if (state.held) {
        setHolding(false);
        swallowClick.current = true;
        return;
      }
      if (event.type === 'pointercancel') return;
      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
        swallowClick.current = true;
        goTo(indexRef.current + (dx < 0 ? 1 : -1));
      }
    };
    // A finger that is traveling is swiping, not holding, however slowly it goes.
    const move = (event: PointerEvent) => {
      const state = press.current;
      if (state.active && !state.held && Math.hypot(event.clientX - state.x, event.clientY - state.y) > 10) {
        window.clearTimeout(state.timer);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [goTo]);

  const zoneClick = (delta: number) => () => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    goTo(indexRef.current + delta);
  };

  const current = slides[index];
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

  return (
    <div
      ref={root}
      className="story"
      role="dialog"
      aria-modal="true"
      aria-label={t('story.title')}
      tabIndex={-1}
      data-holding={holding ? '' : undefined}
    >
      <div className="story-frame" ref={frame} onPointerDown={onPointerDown}>
        <div className="story-top">
          <ol className="story-bars" aria-hidden>
            {slides.map((slide, i) => {
              const done = i < index || (reduced && i === index);
              return (
                <li key={`${slide.kind}-${i}`} className={i === index ? 'is-now' : undefined}>
                  <span
                    ref={i === index ? fill : undefined}
                    className="story-fill"
                    style={{ transform: `scaleX(${done ? 1 : 0})` }}
                  />
                </li>
              );
            })}
          </ol>
          <div className="story-tools">
            <p className="story-pos num">
              {t('app.name')} <span aria-hidden>·</span> {year}
            </p>
            <div className="story-tools-end">
              {!reduced && (
                <button
                  type="button"
                  className="icon-btn story-icon"
                  data-story-ui
                  aria-label={paused ? t('story.resume') : t('story.pause')}
                  aria-pressed={paused}
                  onClick={() => setPaused((value) => !value)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
                    {paused ? <path d="M9 6.5v11l9-5.5z" /> : <path d="M9 6v12M15 6v12" />}
                  </svg>
                </button>
              )}
              <Link
                href={reportHref}
                className="icon-btn story-icon"
                data-story-ui
                aria-label={t('story.close')}
              >
                <Icon name="close" />
              </Link>
            </div>
          </div>
        </div>

        <div
          className="story-stage"
          role="group"
          aria-roledescription={t('story.slideRole')}
          aria-label={t('story.position', { current: index + 1, total })}
        >
          {leaving !== null && !reduced && (
            <SlideView key={`out-${leaving}`} slide={slides[leaving]} index={leaving} year={year} card={card} leaving />
          )}
          <SlideView
            key={`in-${index}`}
            slide={current}
            index={index}
            year={year}
            card={card}
            animate={!reduced}
          />
        </div>

        <button
          type="button"
          className="story-zone story-zone-prev"
          tabIndex={-1}
          aria-label={t('story.prev')}
          onMouseDown={keepFocus}
          onClick={zoneClick(-1)}
        />
        <button
          type="button"
          className="story-zone story-zone-next"
          tabIndex={-1}
          aria-label={t('story.next')}
          onMouseDown={keepFocus}
          onClick={zoneClick(1)}
        />
      </div>

      <button
        type="button"
        className="icon-btn story-arrow story-arrow-prev"
        data-story-ui
        aria-label={t('story.prev')}
        disabled={index === 0}
        onClick={() => goTo(index - 1)}
      >
        <Icon name="back" />
      </button>
      <button
        type="button"
        className="icon-btn story-arrow story-arrow-next"
        data-story-ui
        aria-label={t('story.next')}
        disabled={last}
        onClick={() => goTo(index + 1)}
      >
        <Icon name="chevron" />
      </button>
    </div>
  );
}

/* --- Slides ------------------------------------------------------------------------ */

function useFormat() {
  const locale = useLocale();
  return {
    number: (value: number) => new Intl.NumberFormat(locale).format(value),
    // Built from local components on both sides, so no timezone can shift the day.
    day: (iso: string) => {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(locale, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
    },
    hour: (hour: number) =>
      new Date(2024, 0, 1, hour).toLocaleTimeString(locale, { hour: 'numeric' }),
    // 2024-01-01 was a Monday, matching the Monday-first weekday index.
    weekday: (index: number) =>
      new Date(2024, 0, 1 + index).toLocaleDateString(locale, { weekday: 'long' }),
  };
}

/** Counts up once when it appears; the final value is always what assistive tech reads. */
function CountUp({ to, animate }: { to: number; animate: boolean }) {
  const format = useFormat().number;
  const [value, setValue] = useState(animate ? 0 : to);

  useEffect(() => {
    if (!animate) {
      setValue(to);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 1400);
      setValue(Math.round(to * (1 - (1 - progress) ** 3)));
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, animate]);

  return (
    <>
      <span aria-hidden>{format(value)}</span>
      <span className="sr-only">{format(to)}</span>
    </>
  );
}

/** A figure sized so its widest form always fits the slide, whatever the digit count. */
function Big({ chars, children, small }: { chars: number; children: ReactNode; small?: boolean }) {
  return (
    <p
      className={`story-big num${small ? ' is-small' : ''}`}
      style={{ '--n': Math.max(chars, 2) } as CSSProperties}
    >
      {children}
    </p>
  );
}

/** "4h 0m" or "8 PM" with the space turned into a tight gap; a mono space is far too wide at this size. */
function Parts({ text }: { text: string }) {
  return (
    <>
      {text.split(/[\s\u202f\u00a0]+/).map((part, i) => (
        <span key={i} className="story-part">
          {part}
        </span>
      ))}
    </>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <h2 className="story-eyebrow">{children}</h2>;
}

function TitleBlock({ title, large }: { title: StoryTitle; large?: boolean }) {
  return (
    <p className={`story-name${large ? ' is-large' : ''}`}>{title.label}</p>
  );
}

function SlideView({
  slide,
  index,
  year,
  card,
  leaving,
  animate,
}: {
  slide: Slide;
  index: number;
  year: number;
  card: Card;
  leaving?: boolean;
  animate?: boolean;
}) {
  const t = useStoryT();
  const fmt = useFormat();
  const count = !leaving && animate;

  let body: ReactNode;
  switch (slide.kind) {
    case 'intro':
      body = (
        <>
          <Eyebrow>{t('story.intro.eyebrow')}</Eyebrow>
          <p className="story-year">{slide.year}</p>
          <p className="story-lede">{t('story.intro.name', { name: slide.name })}</p>
          <p className="story-hint">{t('story.hint')}</p>
        </>
      );
      break;

    case 'time': {
      const text = fmt.number(slide.value);
      body = (
        <>
          <Eyebrow>{t('story.time.eyebrow')}</Eyebrow>
          <div className="story-center">
            <Big chars={text.length}>
              <CountUp to={slide.value} animate={!!count} />
            </Big>
            <p className="story-unit">{t(slide.unit === 'hours' ? 'story.unit.hours' : 'story.unit.minutes')}</p>
          </div>
          {slide.days !== null && (
            <p className="story-lede">{t('story.time.days', { days: slide.days })}</p>
          )}
        </>
      );
      break;
    }

    case 'plays': {
      body = (
        <>
          <Eyebrow>{t('story.plays.eyebrow')}</Eyebrow>
          <div className="story-center">
            <Big chars={fmt.number(slide.plays).length}>
              <CountUp to={slide.plays} animate={!!count} />
            </Big>
            <p className="story-unit">{t('story.plays.label')}</p>
            <hr className="story-rule" />
            <p className="story-mid num">{fmt.number(slide.titles)}</p>
            <p className="story-cap">{t('story.plays.titles')}</p>
          </div>
        </>
      );
      break;
    }

    case 'top':
      body = (
        <>
          <Eyebrow>{t('story.top.eyebrow')}</Eyebrow>
          <div className={`story-center${slide.poster ? ' has-poster' : ''}`}>
            {slide.poster && (
              <div className="story-poster-wrap">
                <Poster
                  src={slide.poster}
                  label={slide.label}
                  className="story-poster"
                  loading="eager"
                />
              </div>
            )}
            <TitleBlock title={slide} large={!slide.poster} />
            <dl className="story-pair">
              <div>
                <dt>{t('story.plays.label')}</dt>
                <dd className="num">{fmt.number(slide.plays)}</dd>
              </div>
              <div>
                <dt>{t('common.watchTime')}</dt>
                <dd className="num">
                  <Parts text={formatMinutes(slide.minutes)} />
                </dd>
              </div>
            </dl>
          </div>
        </>
      );
      break;

    case 'versus':
      body = (
        <>
          <Eyebrow>{t('story.versus.eyebrow')}</Eyebrow>
          <div className="story-versus">
            <VersusHalf
              kicker={t('story.versus.show')}
              title={slide.show}
              caption={t('common.episodes')}
            />
            <div className="story-vs" aria-hidden>
              <span>{t('story.versus.vs')}</span>
            </div>
            <VersusHalf
              kicker={t('story.versus.movie')}
              title={slide.movie}
              caption={t('story.plays.label')}
            />
          </div>
        </>
      );
      break;

    case 'genre':
      body = (
        <>
          <Eyebrow>{t('story.genre.eyebrow')}</Eyebrow>
          <div className="story-center">
            <p className="story-name is-huge">{slide.label}</p>
            <Big chars={String(slide.share).length + 1} small>
              <CountUp to={slide.share} animate={!!count} />
              <span>%</span>
            </Big>
            <p className="story-cap">{t('story.genre.share')}</p>
            <div className="story-meter" aria-hidden>
              <span style={{ width: `${Math.min(100, slide.share)}%` }} />
            </div>
          </div>
        </>
      );
      break;

    case 'days':
      body = (
        <>
          <Eyebrow>{t('story.days.eyebrow')}</Eyebrow>
          <div className="story-center story-split">
            {slide.busiest && (
              <div className="story-block">
                <p className="story-kicker">{t('story.days.busiest')}</p>
                <p className="story-name">{fmt.day(slide.busiest.day)}</p>
                <p className="story-mid num">
                  <Parts text={formatMinutes(slide.busiest.minutes)} />
                </p>
              </div>
            )}
            {slide.streak !== null && (
              <div className="story-block">
                <p className="story-kicker">{t('story.days.streak')}</p>
                <Big chars={String(slide.streak).length} small>
                  <CountUp to={slide.streak} animate={!!count} />
                </Big>
                <p className="story-cap">{t('story.days.streakUnit')}</p>
                <div className="story-chain" aria-hidden>
                  {Array.from({ length: Math.min(slide.streak, 31) }, (_, i) => (
                    <span key={i} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      );
      break;

    case 'when': {
      const peak = Math.max(...slide.hours, 1);
      const hourLabel = fmt.hour(slide.hour);
      body = (
        <>
          <Eyebrow>{t('story.when.eyebrow')}</Eyebrow>
          <div className="story-center">
            <p className="story-name is-large">
              {t(`story.when.${slide.part}`, { weekday: fmt.weekday(slide.weekday) })}
            </p>
            <Big chars={hourLabel.length} small>
              <Parts text={hourLabel} />
            </Big>
            <p className="story-cap">{t('story.when.peakHour')}</p>
            <div className="story-hours" role="img" aria-label={t('story.when.chart')}>
              {slide.hours.map((plays, hour) => (
                <span
                  key={hour}
                  className={hour === slide.hour ? 'is-peak' : undefined}
                  style={{ height: `${Math.max(4, (plays / peak) * 100)}%`, opacity: hour === slide.hour ? 1 : 0.28 + 0.5 * (plays / peak) }}
                />
              ))}
            </div>
            <div className="story-hours-axis num" aria-hidden>
              <span>00</span>
              <span>06</span>
              <span>12</span>
              <span>18</span>
              <span>23</span>
            </div>
          </div>
        </>
      );
      break;
    }

    case 'outro':
      body = <Outro year={slide.year} card={card} />;
      break;
  }

  return (
    <section
      className={`story-slide${leaving ? ' is-leaving' : ''}`}
      data-kind={slide.kind}
      data-pos={index % 4}
      aria-hidden={leaving ? true : undefined}
    >
      <span className="story-mark" aria-hidden>
        {year}
      </span>
      <div className="story-body">{body}</div>
    </section>
  );
}

function VersusHalf({
  kicker,
  title,
  caption,
}: {
  kicker: string;
  title: StoryTitle;
  caption: string;
}) {
  const format = useFormat().number;
  return (
    <div className="story-half">
      <div className="story-half-text">
        <p className="story-kicker">{kicker}</p>
        <p className="story-name">{title.label}</p>
        <p className="story-mid num">{format(title.plays)}</p>
        <p className="story-cap">{caption}</p>
      </div>
      {title.poster && (
        <div className="story-poster-wrap is-small">
          <Poster src={title.poster} label={title.label} className="story-poster" loading="eager" />
        </div>
      )}
    </div>
  );
}

/** Closing slide: the card as the server draws it, plus the three ways out. */
function Outro({ year, card }: { year: number; card: Card }) {
  const t = useStoryT();
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    // A real File is needed to ask; an empty one answers for the type.
    const probe = new File([], 'probe.png', { type: 'image/png' });
    setCanShare(typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] }));
  }, []);

  async function share() {
    if (!card.file) return;
    try {
      await navigator.share({ files: [card.file], title: `${t('app.name')} ${year}` });
    } catch {
      // Dismissing the sheet rejects; there is nothing to report.
    }
  }

  return (
    <>
      <Eyebrow>{t('story.outro.eyebrow')}</Eyebrow>
      <div className="story-card-frame" data-ready={card.preview ? '' : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {card.preview && <img src={card.preview} alt={t('story.outro.preview', { year })} />}
      </div>
      <div className="story-actions">
        <a
          className="btn"
          href={card.src}
          download={`watcharr-${year}.png`}
          data-story-ui
        >
          <Icon name="download" />
          {t('story.outro.download')}
        </a>
        {canShare && (
          <button
            type="button"
            className="btn ghost"
            data-story-ui
            disabled={!card.file}
            onClick={share}
          >
            <Icon name="share" />
            {t('story.outro.share')}
          </button>
        )}
        <Link className="btn ghost" href={`/wrapped?year=${year}`} data-story-ui>
          {t('story.backToReport')}
        </Link>
      </div>
    </>
  );
}
