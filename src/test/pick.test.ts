import assert from 'node:assert/strict';
import {
  POOL_CAP,
  applyFilters,
  buildPool,
  buildReel,
  cryptoRng,
  filtersToQuery,
  hasRuntimeData,
  lengthOf,
  parseFilters,
  reasonFor,
  seedTiles,
  weightFor,
  weightedPick,
  type PoolEntry,
} from '../server/pick-core';

const NOW = Date.UTC(2026, 9, 9, 20, 0, 0);
const DAY = 86_400_000;
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Deterministic rng in [0, 1): the same seed always replays the same draws. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
/** An rng that returns the given values in turn, then repeats the last one. */
const fixed = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

const entry = (id: string, over: Partial<PoolEntry> = {}): PoolEntry => ({
  itemId: id,
  title: `Title ${id}`,
  year: 2000,
  mediaType: 'movie',
  genres: [],
  runtimeMin: null,
  source: 'planned',
  addedAt: NOW - 10 * DAY,
  ...over,
});
const cand = (id: string, weight = 1, over: Record<string, unknown> = {}) => ({
  itemId: id,
  weight,
  mediaType: 'movie',
  runtimeMin: null as number | null,
  ...over,
});

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}\n${error instanceof Error ? (error.stack ?? error.message) : error}`);
  }
}

/* ---- weights and reasons ---- */

check('watching beats a fresh planned title and equals the oldest planned one', () => {
  const watching = weightFor(entry('a', { source: 'watching' }), NOW, 0);
  const fresh = weightFor(entry('b', { addedAt: NOW }), NOW, 0);
  const old = weightFor(entry('c', { addedAt: NOW - 400 * DAY }), NOW, 0);
  assert.equal(watching, 3);
  assert.equal(fresh, 1);
  assert.equal(old, 3);
  assert.ok(watching > fresh);
});

check('a planned title gains odds the longer it waits, but only up to the cap', () => {
  const at = (days: number) => weightFor(entry('x', { addedAt: NOW - days * DAY }), NOW, 0);
  assert.ok(at(30) > at(5));
  assert.equal(at(90), at(900));
});

check('a library suggestion scales with its score and is always above zero', () => {
  const at = (score: number | undefined, max: number) =>
    weightFor(entry('l', { source: 'library', score }), NOW, max);
  assert.equal(at(10, 10), 2);
  assert.equal(at(5, 10), 1.25);
  assert.equal(at(0, 10), 0.5);
  assert.equal(at(undefined, 10), 0.5);
  assert.equal(at(5, 0), 0.5); // no usable maximum: do not divide by zero
  assert.equal(at(99, 10), 2); // clamped
});

check('reasons: started, added today, waiting since a date, library', () => {
  assert.deepEqual(reasonFor(entry('a', { source: 'watching' }), NOW, fmt), { key: 'pick.reason.watching' });
  assert.deepEqual(reasonFor(entry('b', { addedAt: NOW - 3600_000 }), NOW, fmt), { key: 'pick.reason.today' });
  assert.deepEqual(reasonFor(entry('c', { addedAt: NOW - 12 * DAY }), NOW, fmt), {
    key: 'pick.reason.waiting',
    text: fmt(NOW - 12 * DAY),
  });
  assert.deepEqual(reasonFor(entry('d', { source: 'library' }), NOW, fmt), { key: 'pick.reason.library' });
});

/* ---- the pool ---- */

check('buildPool: empty input gives an empty pool', () => {
  assert.deepEqual(buildPool([], NOW, fmt), []);
});

check('buildPool: weights are attached and the heaviest comes first', () => {
  const pool = buildPool(
    [entry('new', { addedAt: NOW }), entry('started', { source: 'watching' }), entry('lib', { source: 'library', score: 2 })],
    NOW,
    fmt,
  );
  assert.deepEqual(pool.map((p) => p.itemId), ['started', 'lib', 'new']);
  assert.ok(pool.every((p) => p.weight > 0 && p.reason.key.startsWith('pick.reason.')));
});

check('buildPool: the same item id twice yields one entry', () => {
  const pool = buildPool([entry('a'), entry('a', { title: 'Other' })], NOW, fmt);
  assert.equal(pool.length, 1);
});

check('buildPool: a watchlist entry and a library suggestion of the same title collapse to the heavier one', () => {
  const pool = buildPool(
    [
      entry('lib-9', { title: 'Heat', year: 1995, source: 'library', score: 3 }),
      entry('wl-1', { title: ' heat ', year: 1995, source: 'watching' }),
    ],
    NOW,
    fmt,
  );
  assert.equal(pool.length, 1);
  assert.equal(pool[0].itemId, 'wl-1');
});

check('buildPool: same title but a different year or kind is a different title', () => {
  const pool = buildPool(
    [
      entry('a', { title: 'Dune', year: 1984 }),
      entry('b', { title: 'Dune', year: 2021 }),
      entry('c', { title: 'Dune', year: 2021, mediaType: 'series' }),
    ],
    NOW,
    fmt,
  );
  assert.equal(pool.length, 3);
});

check('buildPool: capped at 40, keeping the heaviest, and deterministic', () => {
  const many = Array.from({ length: 60 }, (_, i) => entry(`m${i}`, { addedAt: NOW - i * DAY }));
  const a = buildPool(many, NOW, fmt);
  const b = buildPool(many, NOW, fmt);
  assert.equal(a.length, POOL_CAP);
  assert.deepEqual(a.map((p) => p.itemId), b.map((p) => p.itemId));
  // The oldest entries carry the highest weight, so the newest 20 are the ones dropped.
  assert.ok(a.some((p) => p.itemId === 'm59'));
  assert.ok(!a.some((p) => p.itemId === 'm0'));
});

check('buildPool: a tie at the cap is settled by lot, so every entry gets a seat sometimes', () => {
  const planned = Array.from({ length: 60 }, (_, i) => entry(`p${i}`, { addedAt: NOW - 10 * DAY }));
  const watching = [entry('w1', { source: 'watching' }), entry('w2', { source: 'watching' })];
  const seen = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    const pool = buildPool([...watching, ...planned], NOW, fmt, POOL_CAP, seeded(seed));
    assert.equal(pool.length, POOL_CAP);
    assert.equal(new Set(pool.map((p) => p.itemId)).size, POOL_CAP);
    // Nothing is heavier than a started title, so those two are always in.
    assert.ok(pool.some((p) => p.itemId === 'w1') && pool.some((p) => p.itemId === 'w2'));
    for (const p of pool) seen.add(p.itemId);
  }
  assert.equal(seen.size, 62);
  const a = buildPool([...watching, ...planned], NOW, fmt, POOL_CAP, seeded(7));
  const b = buildPool([...watching, ...planned], NOW, fmt, POOL_CAP, seeded(7));
  assert.deepEqual(a.map((p) => p.itemId), b.map((p) => p.itemId));
});

check('buildPool: extra fields on an entry survive (the loader hangs its poster on them)', () => {
  const [one] = buildPool([{ ...entry('a'), poster: '/p/a' }], NOW, fmt);
  assert.equal(one.poster, '/p/a');
});

/* ---- the draw ---- */

check('weightedPick: nothing to draw from gives null', () => {
  assert.equal(weightedPick([], fixed(0.5)), null);
  assert.equal(weightedPick([cand('a')], fixed(0.5), new Set(['a'])), null);
});

check('weightedPick: a single candidate always wins', () => {
  for (const r of [0, 0.5, 0.999999, 1]) assert.equal(weightedPick([cand('a')], fixed(r))?.itemId, 'a');
});

check('weightedPick: the injected rng decides, and the same rng replays the same result', () => {
  const pool = [cand('a', 1), cand('b', 2), cand('c', 1)];
  assert.equal(weightedPick(pool, fixed(0))?.itemId, 'a');
  assert.equal(weightedPick(pool, fixed(0.24))?.itemId, 'a');
  assert.equal(weightedPick(pool, fixed(0.26))?.itemId, 'b');
  assert.equal(weightedPick(pool, fixed(0.74))?.itemId, 'b');
  assert.equal(weightedPick(pool, fixed(0.76))?.itemId, 'c');
  const run = (seed: number) => Array.from({ length: 20 }, (_, i) => weightedPick(pool, seeded(seed + i))?.itemId);
  assert.deepEqual(run(7), run(7));
});

check('weightedPick: rng at the very top of the range still returns a real entry', () => {
  const pool = [cand('a', 1), cand('b', 1), cand('z', 0)];
  assert.equal(weightedPick(pool, fixed(1))?.itemId, 'b'); // not the zero-weight tail
});

check('weightedPick: excluded ids are never returned (Set and array)', () => {
  const pool = [cand('a', 1), cand('b', 1), cand('c', 1)];
  for (let seed = 1; seed <= 200; seed++) {
    const rng = seeded(seed);
    assert.notEqual(weightedPick(pool, rng, new Set(['a', 'c']))?.itemId, 'a');
    assert.equal(weightedPick(pool, seeded(seed), ['a', 'c'])?.itemId, 'b');
  }
});

check('weightedPick: rejecting every title one by one visits each exactly once, then returns null', () => {
  const pool = [cand('a', 1), cand('b', 3), cand('c', 2), cand('d', 1)];
  const rejected = new Set<string>();
  const rng = seeded(42);
  for (let i = 0; i < pool.length; i++) {
    const pick = weightedPick(pool, rng, rejected);
    assert.ok(pick && !rejected.has(pick.itemId));
    rejected.add(pick.itemId);
  }
  assert.equal(rejected.size, 4);
  assert.equal(weightedPick(pool, rng, rejected), null);
});

check('weightedPick: frequencies follow the weights', () => {
  const pool = [cand('light', 1), cand('heavy', 3)];
  const rng = seeded(2026);
  let heavy = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) if (weightedPick(pool, rng)?.itemId === 'heavy') heavy++;
  assert.ok(Math.abs(heavy / n - 0.75) < 0.02, `heavy won ${heavy / n}`);
});

check('weightedPick: zero, negative and NaN weights are treated as zero; all-zero falls back to uniform', () => {
  const pool = [cand('bad', Number.NaN), cand('neg', -5), cand('ok', 1)];
  for (let seed = 1; seed <= 50; seed++) assert.equal(weightedPick(pool, seeded(seed))?.itemId, 'ok');
  const flat = [cand('a', 0), cand('b', 0)];
  assert.equal(weightedPick(flat, fixed(0.1))?.itemId, 'a');
  assert.equal(weightedPick(flat, fixed(0.9))?.itemId, 'b');
});

check('weightedPick: does not mutate its input', () => {
  const pool = [cand('a'), cand('b')];
  const copy = structuredClone(pool);
  weightedPick(pool, fixed(0.5), ['a']);
  assert.deepEqual(pool, copy);
});

check('cryptoRng stays in [0, 1)', () => {
  for (let i = 0; i < 500; i++) {
    const r = cryptoRng();
    assert.ok(r >= 0 && r < 1);
  }
});

/* ---- filters ---- */

const mixed = [
  cand('film-short', 1, { mediaType: 'movie', runtimeMin: 92 }),
  cand('film-edge', 1, { mediaType: 'movie', runtimeMin: 100 }),
  cand('film-long', 1, { mediaType: 'movie', runtimeMin: 148 }),
  cand('film-unknown', 1, { mediaType: 'movie', runtimeMin: null }),
  cand('show-hour', 1, { mediaType: 'series', runtimeMin: 58 }),
  cand('show-plex', 1, { mediaType: 'show', runtimeMin: 130 }),
  cand('episode', 1, { mediaType: 'episode', runtimeMin: null }),
  cand('odd', 1, { mediaType: 'unknown', runtimeMin: 80 }),
];
const ids = (items: { itemId: string }[]) => items.map((i) => i.itemId);

check('filters: type', () => {
  assert.equal(applyFilters(mixed, { type: 'any', length: 'any' }).length, mixed.length);
  assert.deepEqual(ids(applyFilters(mixed, { type: 'movie', length: 'any' })), [
    'film-short', 'film-edge', 'film-long', 'film-unknown',
  ]);
  // "show" (Plex) and "episode" count as series; an unrecognized type matches neither side.
  assert.deepEqual(ids(applyFilters(mixed, { type: 'series', length: 'any' })), ['show-hour', 'show-plex', 'episode']);
});

check('filters: quick is up to 100 minutes or an episode, long is the rest, unknown is neither', () => {
  assert.deepEqual(ids(applyFilters(mixed, { type: 'any', length: 'quick' })), [
    'film-short', 'film-edge', 'show-hour', 'episode', 'odd',
  ]);
  assert.deepEqual(ids(applyFilters(mixed, { type: 'any', length: 'long' })), ['film-long', 'show-plex']);
  assert.equal(lengthOf(cand('x', 1, { runtimeMin: null })), null);
});

check('filters: type and length combine', () => {
  assert.deepEqual(ids(applyFilters(mixed, { type: 'movie', length: 'quick' })), ['film-short', 'film-edge']);
  assert.deepEqual(applyFilters([], { type: 'movie', length: 'long' }), []);
});

check('filters: the length filter is only offered when some title has a runtime', () => {
  assert.equal(hasRuntimeData([]), false);
  assert.equal(hasRuntimeData([cand('a'), cand('b')]), false);
  assert.equal(hasRuntimeData([cand('a'), cand('b', 1, { runtimeMin: 90 })]), true);
  assert.equal(hasRuntimeData([cand('e', 1, { mediaType: 'episode' })]), true);
});

check('filters: query string round trip, garbage falls back to any', () => {
  assert.deepEqual(parseFilters({}), { type: 'any', length: 'any' });
  assert.deepEqual(parseFilters({ type: 'movie', len: 'quick' }), { type: 'movie', length: 'quick' });
  assert.deepEqual(parseFilters({ type: ['series', 'movie'], len: ['long'] }), { type: 'series', length: 'long' });
  assert.deepEqual(parseFilters({ type: '<script>', len: '99' }), { type: 'any', length: 'any' });
  assert.equal(filtersToQuery({ type: 'any', length: 'any' }), '');
  assert.equal(filtersToQuery({ type: 'movie', length: 'any' }), 'type=movie');
  assert.equal(filtersToQuery({ type: 'series', length: 'long' }), 'type=series&len=long');
  const f = { type: 'movie', length: 'quick' } as const;
  assert.deepEqual(parseFilters(Object.fromEntries(new URLSearchParams(filtersToQuery(f)))), f);
});

/* ---- the reel ---- */

const tiles = (n: number) => Array.from({ length: n }, (_, i) => ({ itemId: `t${i}` }));
const noTwinsNextToEachOther = (strip: { itemId: string }[]) =>
  strip.every((tile, i) => i === 0 || tile.itemId !== strip[i - 1].itemId);

check('reel: the winner sits at `land`, with a tail behind it and the head untouched', () => {
  for (const size of [2, 3, 5, 12, 40]) {
    const pool = tiles(size);
    for (let seed = 1; seed <= 40; seed++) {
      const winner = pool[seed % size];
      const head = seedTiles(pool, seeded(seed));
      const reel = buildReel(pool, winner, seeded(seed * 7), head);
      assert.equal(reel.tiles[reel.land], winner);
      assert.ok(reel.tiles.length >= reel.land + 6);
      assert.equal(reel.start, 5);
      assert.deepEqual(reel.tiles.slice(0, head.length), head);
      assert.ok(reel.land > reel.start + 15, 'the reel must travel a long way');
    }
  }
});

check('reel: no tile is next to itself, for pools of two and up', () => {
  for (const size of [2, 3, 4, 9, 40]) {
    const pool = tiles(size);
    for (let seed = 1; seed <= 200; seed++) {
      const winner = pool[seed % size];
      const reel = buildReel(pool, winner, seeded(seed));
      assert.ok(noTwinsNextToEachOther(reel.tiles), `pool ${size}, seed ${seed}`);
    }
  }
});

check('reel: a re-spin that carries the visible window starts exactly where the last one stopped', () => {
  const pool = tiles(8);
  const first = buildReel(pool, pool[3], seeded(11));
  const window = first.tiles.slice(first.land - 5, first.land + 6);
  assert.equal(window.length, 11);
  const second = buildReel(pool.filter((p) => p !== pool[3]), pool[6], seeded(12), window);
  assert.deepEqual(second.tiles.slice(0, 11), window);
  assert.equal(second.tiles[second.start], pool[3]);
  assert.equal(second.tiles[second.land], pool[6]);
});

check('reel: the same rng builds the same reel', () => {
  const pool = tiles(10);
  const a = buildReel(pool, pool[4], seeded(5));
  const b = buildReel(pool, pool[4], seeded(5));
  assert.deepEqual(a, b);
});

check('reel: a pool of one does not crash', () => {
  const pool = tiles(1);
  const reel = buildReel(pool, pool[0], seeded(1));
  assert.equal(reel.tiles[reel.land], pool[0]);
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall pick tests passed');
