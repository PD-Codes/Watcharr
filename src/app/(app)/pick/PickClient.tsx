'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import Poster from '@/components/Poster';
import { Icon } from '@/components/Icons';
import { formatMinutes } from '@/components/format';
import { useT } from '@/i18n/client';
import {
  QUICK_MAX_MIN,
  REEL_HEAD,
  applyFilters,
  buildReel,
  cryptoRng,
  filtersToQuery,
  kindOf,
  seedTiles,
  weightedPick,
  DEFAULT_FILTERS,
  type LengthFilter,
  type PickCandidate,
  type PickFilters,
  type Reel,
  type TypeFilter,
} from '@/server/pick-core';

// The CSS reads --spin, so the duration lives in exactly one place.
const SPIN_MS = 3800;
// The easing leaves the last pixels crawling for a long time, so the reel counts as stopped
// at this share of the duration instead of when the transition formally ends.
const STOPPED_AT = 0.8;
// The beat between the reel stopping and the result card opening.
const SETTLE_MS = 700;
// Time the collapsed reel needs to open again before a re-spin starts moving.
const REOPEN_MS = 420;

type Phase = 'idle' | 'spinning' | 'result';
type Mark = 'busy' | 'done' | 'error';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function PickClient({
  candidates,
  initialFilters,
  hasRuntime,
  openIn,
}: {
  candidates: PickCandidate[];
  initialFilters: PickFilters;
  hasRuntime: boolean;
  /** OpenInServer rendered on the server for each candidate, keyed by item id. */
  openIn: Record<string, ReactNode>;
}) {
  const t = useT();
  const [filters, setFilters] = useState(initialFilters);
  const [rejected, setRejected] = useState<ReadonlySet<string>>(() => new Set());
  const [phase, setPhase] = useState<Phase>('idle');
  const [winner, setWinner] = useState<PickCandidate | null>(null);
  const [reel, setReel] = useState<Reel<PickCandidate> | null>(null);
  const [landed, setLanded] = useState(false);
  const [spinId, setSpinId] = useState(0);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const strip = useRef<HTMLDivElement>(null);
  const lead = useRef(0);

  const pool = useMemo(() => applyFilters(candidates, filters), [candidates, filters]);
  const left = useMemo(() => pool.filter((c) => !rejected.has(c.itemId)), [pool, rejected]);
  const spinning = phase === 'spinning';

  // What the result card shows. A lone remaining title is shown directly, with no reel; a
  // winner that a filter change has since removed is not shown at all.
  const lone = left.length === 1 ? left[0] : null;
  const kept = phase === 'result' && winner && pool.some((c) => c.itemId === winner.itemId) ? winner : null;
  const current = spinning ? null : (kept ?? lone);
  const exhausted = !spinning && pool.length > 0 && left.length === 0;

  // Warm the cache for every poster the reel can show. A spin pulls dozens of tiles in a
  // second, and one that is still downloading flashes as an empty frame while it passes.
  // Delayed so the strip that is already on screen gets its images first.
  useEffect(() => {
    if (candidates.length < 2) return;
    const warm = window.setTimeout(() => {
      for (const c of candidates) {
        const img = new Image();
        img.fetchPriority = 'low';
        img.src = c.poster;
      }
    }, 500);
    return () => window.clearTimeout(warm);
  }, [candidates]);

  // The static strip behind the button. Built after mount: it is random, and the server
  // render has to match the first client render.
  useEffect(() => {
    const mid = Math.floor(REEL_HEAD / 2);
    setReel(pool.length > 1 ? { tiles: seedTiles(pool, cryptoRng), start: mid, land: mid } : null);
  }, [pool]);

  // Park the strip on the tile that is meant to be centered before it paints, without a
  // transition. A re-spin carries the previous window over, so this is what makes it start
  // exactly where the last one stopped.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el || !reel) return;
    el.style.transition = 'none';
    el.style.setProperty('--i', String(reel.start));
    void el.offsetWidth;
    el.style.transition = '';
  }, [reel]);

  // Start moving, and call it stopped on a timer rather than on transitionend, which a
  // background tab may never report.
  useEffect(() => {
    if (!spinning || !reel) return;
    const begin = window.setTimeout(() => {
      strip.current?.style.setProperty('--i', String(reel.land));
    }, lead.current);
    const stopped = window.setTimeout(() => setLanded(true), lead.current + SPIN_MS * STOPPED_AT);
    return () => {
      window.clearTimeout(begin);
      window.clearTimeout(stopped);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId]);

  useEffect(() => {
    if (!landed) return;
    const open = window.setTimeout(() => setPhase('result'), SETTLE_MS);
    return () => window.clearTimeout(open);
  }, [landed]);

  function spin(skip: ReadonlySet<string>) {
    if (spinning) return;
    setRejected(skip);
    setLanded(false);
    const pick = weightedPick(pool, cryptoRng, skip);
    if (!pick) {
      setWinner(null);
      setPhase('idle');
      return;
    }
    const open = pool.filter((c) => !skip.has(c.itemId));
    if (open.length === 1 || reducedMotion()) {
      setWinner(pick);
      setPhase('result');
      return;
    }

    // Carry the window the last spin stopped on, as long as every tile in it is still allowed.
    const half = Math.floor(REEL_HEAD / 2);
    const ids = new Set(pool.map((c) => c.itemId));
    const visible = reel?.tiles.slice(reel.land - half, reel.land + half + 1) ?? [];
    const head = visible.length === REEL_HEAD && visible.every((c) => ids.has(c.itemId)) ? visible : undefined;

    lead.current = current ? REOPEN_MS : 60;
    setReel(buildReel(open, pick, cryptoRng, head));
    setWinner(pick);
    setSpinId((n) => n + 1);
    setPhase('spinning');
  }

  function onMain() {
    if (spinning) return;
    if (exhausted) {
      setRejected(new Set());
      setWinner(null);
      setPhase('idle');
      return;
    }
    spin(current ? new Set([...rejected, current.itemId]) : rejected);
  }

  function change(patch: Partial<PickFilters>) {
    if (spinning) return;
    const next = { ...filters, ...patch };
    setFilters(next);
    const query = filtersToQuery(next);
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  }

  async function markWatching(c: PickCandidate) {
    setMarks((m) => ({ ...m, [c.itemId]: 'busy' }));
    try {
      const res = await fetch('/api/watchlist', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: c.itemId, status: 'watching' }),
      });
      setMarks((m) => ({ ...m, [c.itemId]: res.ok ? 'done' : 'error' }));
    } catch {
      setMarks((m) => ({ ...m, [c.itemId]: 'error' }));
    }
  }

  const reasonText = (c: PickCandidate) => t(c.reason.key, { text: c.reason.text ?? '' });
  let announcement = '';
  if (spinning) announcement = t('pick.spinning');
  else if (current && marks[current.itemId] === 'done') announcement = t('pick.announceMarked', { title: current.title });
  else if (current) announcement = t('pick.announce', { title: current.title, reason: reasonText(current) });
  else if (exhausted) announcement = t('pick.exhaustedTitle');

  const mainLabel = spinning
    ? t('pick.spinning')
    : exhausted
      ? t('pick.startOver')
      : current
        ? t('pick.notTonight')
        : t('pick.spin');
  // One title and nothing skipped: there is nothing to spin, so there is no button either.
  const showMain = pool.length > 0 && !(lone && rejected.size === 0 && !exhausted);

  return (
    <>
      <div className="pick-bar">
        <div className="pick-filters">
          <Segment
            label={t('pick.filterType')}
            value={filters.type}
            disabled={spinning}
            onChange={(type) => change({ type: type as TypeFilter })}
            options={[
              ['any', t('pick.typeAny')],
              ['movie', t('pick.typeMovie')],
              ['series', t('pick.typeSeries')],
            ]}
          />
          {hasRuntime && (
            <Segment
              label={t('pick.filterLength')}
              value={filters.length}
              disabled={spinning}
              onChange={(length) => change({ length: length as LengthFilter })}
              options={[
                ['any', t('pick.lengthAny')],
                ['quick', t('pick.lengthQuick'), t('pick.quickHint', { minutes: QUICK_MAX_MIN })],
                ['long', t('pick.lengthLong'), t('pick.longHint', { minutes: QUICK_MAX_MIN })],
              ]}
            />
          )}
        </div>
        <p className="pick-count">
          <span>{t('pick.pool')}</span> <span className="num">{left.length}</span>
          {rejected.size > 0 && (
            <>
              <span aria-hidden> · </span>
              <span>{t('pick.skipped')}</span> <span className="num">{rejected.size}</span>
              <button
                type="button"
                className="link pick-reset"
                disabled={spinning}
                onClick={() => {
                  setRejected(new Set());
                  setWinner(null);
                  setPhase('idle');
                }}
              >
                {t('pick.startOver')}
              </button>
            </>
          )}
        </p>
      </div>

      <section className="pick-stage card" data-phase={phase}>
        <div className="pick-reel" data-open={pool.length > 1 && !current && !exhausted}>
          <div className="pick-reel-inner" aria-hidden="true">
            <div className="pick-window" data-landed={spinning && landed}>
              <div className="pick-clip">
                <div
                  ref={strip}
                  className="pick-strip"
                  style={{ '--spin': `${SPIN_MS}ms` } as CSSProperties}
                >
                  {reel?.tiles.map((c, i) => (
                    <div
                      className="pick-tile"
                      key={`${i}-${c.itemId}`}
                      data-win={spinning && i === reel.land ? '' : undefined}
                    >
                      <Poster src={c.poster} fallback={c.fallback ?? undefined} label={c.title} loading="eager" />
                    </div>
                  ))}
                </div>
              </div>
              <span className="pick-gate" />
            </div>
          </div>
        </div>

        {current && (
          <ResultCard
            key={current.itemId}
            c={current}
            reason={reasonText(current)}
            openIn={openIn[current.itemId]}
            mark={marks[current.itemId]}
            onMark={() => markWatching(current)}
          />
        )}

        {pool.length === 0 && (
          <div className="pick-note">
            <h2>{t('pick.noMatchTitle')}</h2>
            <p className="muted">{t('pick.noMatchBody')}</p>
            <button type="button" className="tonal" onClick={() => change(DEFAULT_FILTERS)}>
              {t('pick.resetFilters')}
            </button>
          </div>
        )}

        {exhausted && (
          <div className="pick-note">
            <h2>{t('pick.exhaustedTitle')}</h2>
            <p className="muted">{t('pick.exhaustedBody')}</p>
          </div>
        )}

        {!current && !exhausted && pool.length > 0 && <p className="pick-hint muted">{t('pick.hint')}</p>}

        {showMain && (
          <div className="pick-controls">
            {/* aria-disabled, not disabled: a button that disables itself under the keyboard drops focus. */}
            <button type="button" className="pick-go" aria-disabled={spinning} onClick={onMain}>
              <Icon name="dice" />
              {mainLabel}
            </button>
          </div>
        )}

        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
      </section>
    </>
  );
}

function Segment({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: [value: string, label: string, tip?: string][];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="pick-field" role="group" aria-label={label}>
      <span className="eyebrow" aria-hidden>
        {label}
      </span>
      <div className="pick-seg">
        {options.map(([optionValue, text, tip]) => (
          <button
            key={optionValue}
            type="button"
            aria-pressed={value === optionValue}
            aria-disabled={disabled}
            data-tip={tip}
            onClick={() => !disabled && onChange(optionValue)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function ResultCard({
  c,
  reason,
  openIn,
  mark,
  onMark,
}: {
  c: PickCandidate;
  reason: string;
  openIn: ReactNode;
  mark: Mark | undefined;
  onMark: () => void;
}) {
  const t = useT();
  const kind = kindOf(c.mediaType);
  const runtime =
    c.runtimeMin == null
      ? null
      : kind === 'series'
        ? t('pick.perEpisode', { time: formatMinutes(c.runtimeMin) })
        : formatMinutes(c.runtimeMin);

  return (
    <article className="pick-result" aria-labelledby="pick-result-title">
      <div className="pick-result-poster">
        <Poster src={c.poster} fallback={c.fallback ?? undefined} label={c.title} loading="eager" />
      </div>
      <div className="pick-result-body">
        <p className="eyebrow">{t('pick.resultEyebrow')}</p>
        <h2 id="pick-result-title" className="pick-title">
          {c.title}
        </h2>
        <p className="pick-meta">
          {c.year != null && <span className="num">{c.year}</span>}
          {kind && <span>{t(kind === 'movie' ? 'pick.kindMovie' : 'pick.kindSeries')}</span>}
          {runtime && <span className="num">{runtime}</span>}
        </p>
        {c.genres.length > 0 && (
          <ul className="chips">
            {c.genres.slice(0, 5).map((genre) => (
              <li className="badge" key={genre}>
                {genre}
              </li>
            ))}
          </ul>
        )}
        <p className="pick-why">
          <Icon name="sparkles" />
          <span>{reason}</span>
        </p>
      </div>
      <div className="pick-actions">
        {c.hasPlays && (
          <Link className="btn ghost" href={`/title/${encodeURIComponent(c.title)}`}>
            {t('pick.openTitle')}
          </Link>
        )}
        {openIn}
        {c.canMarkWatching && (
          <button
            type="button"
            className="tonal"
            aria-disabled={mark === 'busy' || mark === 'done'}
            onClick={() => mark !== 'busy' && mark !== 'done' && onMark()}
          >
            {mark === 'done' ? t('pick.marked') : mark === 'busy' ? t('pick.marking') : t('pick.markWatching')}
          </button>
        )}
      </div>
      {mark === 'error' && (
        <p className="error pick-error" role="alert">
          {t('pick.markError')}
        </p>
      )}
    </article>
  );
}
