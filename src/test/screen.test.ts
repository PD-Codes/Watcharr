import assert from 'node:assert/strict';
import manifest from '../app/manifest';
import {
  CLOCK_TOLERANCE_MS,
  DIM_AFTER_MS,
  DIM_LEVEL,
  DIM_RAMP_MS,
  DRIFT_CYCLE_MS,
  DRIFT_MAX_PX,
  MAX_EXTRAPOLATION_MS,
  clockParts,
  driftOffset,
  idleDim,
  isAdvancing,
  nextSlide,
  orderStreams,
  positionAt,
  reconcileClock,
  relativeAge,
  serverPosition,
  uniqueTitles,
  type StreamClock,
} from '../server/screen-core';

let failed = 0;

function test(name: string, run: () => void) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(error);
  }
}

const NOW = Date.UTC(2026, 9, 9, 20, 41, 0);
const S = 1000;
const row = (over: Partial<Parameters<typeof serverPosition>[0]> = {}) => ({
  state: 'playing',
  progressMs: 600 * S,
  durationMs: 7200 * S,
  progressAt: NOW,
  ...over,
});

// --- hero order ----------------------------------------------------------------------

test('hero: a playing stream outranks a paused one, whatever started later', () => {
  const ordered = orderStreams([
    { key: 'a', state: 'paused', startedAt: 900 },
    { key: 'b', state: 'playing', startedAt: 100 },
  ]);
  assert.deepEqual(ordered.map((s) => s.key), ['b', 'a']);
});

test('hero: among playing streams the newest start wins', () => {
  const ordered = orderStreams([
    { key: 'old', state: 'playing', startedAt: 100 },
    { key: 'new', state: 'playing', startedAt: 500 },
  ]);
  assert.equal(ordered[0].key, 'new');
});

test('hero: buffering sits between playing and paused', () => {
  const ordered = orderStreams([
    { key: 'p', state: 'paused', startedAt: 3 },
    { key: 'b', state: 'buffering', startedAt: 2 },
    { key: 'g', state: 'playing', startedAt: 1 },
  ]);
  assert.deepEqual(ordered.map((s) => s.key), ['g', 'b', 'p']);
});

test('hero: order is stable between refreshes (identical starts fall back to the key)', () => {
  const input = [
    { key: 'z', state: 'playing', startedAt: 5 },
    { key: 'a', state: 'playing', startedAt: 5 },
  ];
  assert.deepEqual(orderStreams(input).map((s) => s.key), ['a', 'z']);
  assert.deepEqual(orderStreams([...input].reverse()).map((s) => s.key), ['a', 'z']);
});

test('hero: no streams, no hero, and the input is not mutated', () => {
  assert.deepEqual(orderStreams([]), []);
  const input = [
    { key: 'b', state: 'paused', startedAt: 1 },
    { key: 'a', state: 'playing', startedAt: 1 },
  ];
  orderStreams(input);
  assert.equal(input[0].key, 'b');
});

// --- server position -----------------------------------------------------------------

test('position: a playing stream is carried forward from when the position last moved', () => {
  assert.equal(serverPosition(row({ progressAt: NOW - 4 * S }), NOW), 604 * S);
});

test('position: a paused stream stands still however old the row is', () => {
  assert.equal(serverPosition(row({ state: 'paused', progressAt: NOW - 20 * S }), NOW), 600 * S);
});

test('position: a buffering stream does not advance either', () => {
  assert.equal(serverPosition(row({ state: 'buffering', progressAt: NOW - 5 * S }), NOW), 600 * S);
});

test('position: extrapolation is capped, so a frozen client does not run away', () => {
  assert.equal(
    serverPosition(row({ progressAt: NOW - 10 * 60 * S }), NOW),
    600 * S + MAX_EXTRAPOLATION_MS,
  );
});

test('position: a row stamped in the future (clock skew) never goes backwards', () => {
  assert.equal(serverPosition(row({ progressAt: NOW + 9 * S }), NOW), 600 * S);
});

test('position: never past the runtime, and an unknown runtime is not a ceiling', () => {
  assert.equal(
    serverPosition(row({ progressMs: 7195 * S, progressAt: NOW - 20 * S }), NOW),
    7200 * S,
  );
  assert.equal(serverPosition(row({ durationMs: 0, progressAt: NOW - 20 * S }), NOW), 620 * S);
});

test('advancing: only a playing stream heard from within the extrapolation window', () => {
  assert.equal(isAdvancing({ state: 'playing', progressAt: NOW - 5 * S }, NOW), true);
  assert.equal(isAdvancing({ state: 'playing', progressAt: NOW - MAX_EXTRAPOLATION_MS - 1 }, NOW), false);
  assert.equal(isAdvancing({ state: 'paused', progressAt: NOW }, NOW), false);
  assert.equal(isAdvancing({ state: 'buffering', progressAt: NOW }, NOW), false);
});

// --- running clock -------------------------------------------------------------------

const clock = (over: Partial<StreamClock> = {}): StreamClock => ({
  positionMs: 600 * S,
  at: NOW,
  playing: true,
  durationMs: 7200 * S,
  ...over,
});

test('clock: a playing stream advances with the wall clock, a paused one does not', () => {
  assert.equal(positionAt(clock(), NOW + 7 * S), 607 * S);
  assert.equal(positionAt(clock({ playing: false }), NOW + 7 * S), 600 * S);
});

test('clock: never behind its anchor, never past the runtime', () => {
  assert.equal(positionAt(clock(), NOW - 5 * S), 600 * S);
  assert.equal(positionAt(clock({ positionMs: 7199 * S }), NOW + 60 * S), 7200 * S);
});

test('reconcile: the first sighting of a stream adopts the server value', () => {
  const next = { positionMs: 42 * S, playing: true, durationMs: 100 * S };
  assert.deepEqual(reconcileClock(undefined, next, NOW), { ...next, at: NOW });
});

test('reconcile (regression): a fresh value a little behind does not rewind the timecode', () => {
  const prev = clock();
  const later = NOW + 10 * S; // the running clock says 610 s
  const kept = reconcileClock(prev, { positionMs: 608 * S, playing: true, durationMs: 7200 * S }, later);
  assert.equal(kept, prev);
  assert.equal(positionAt(kept, later), 610 * S);
});

test('reconcile: a seek beyond the tolerance snaps to the server', () => {
  const later = NOW + 10 * S;
  const snapped = reconcileClock(
    clock(),
    { positionMs: 610 * S + CLOCK_TOLERANCE_MS + 1, playing: true, durationMs: 7200 * S },
    later,
  );
  assert.equal(snapped.positionMs, 610 * S + CLOCK_TOLERANCE_MS + 1);
  assert.equal(snapped.at, later);
});

test('reconcile: pausing and resuming always take the server value', () => {
  const paused = reconcileClock(clock(), { positionMs: 610 * S, playing: false, durationMs: 7200 * S }, NOW + 10 * S);
  assert.equal(paused.playing, false);
  assert.equal(positionAt(paused, NOW + 99 * S), 610 * S);
  const resumed = reconcileClock(paused, { positionMs: 610 * S, playing: true, durationMs: 7200 * S }, NOW + 20 * S);
  assert.equal(resumed.playing, true);
  assert.equal(resumed.at, NOW + 20 * S);
});

test('reconcile: the next episode on the same session starts over, however close the numbers are', () => {
  const next = reconcileClock(clock(), { positionMs: 600 * S, playing: true, durationMs: 2700 * S }, NOW);
  assert.equal(next.durationMs, 2700 * S);
});

// --- wall clock ----------------------------------------------------------------------

test('clock face: en-US is 12 h with the period split off', () => {
  const parts = clockParts(NOW, 'en-US', 'UTC');
  assert.equal(parts.time, '8:41');
  assert.equal(parts.period, 'PM');
  assert.match(parts.date, /Friday/);
});

test('clock face: de-DE is 24 h without a period, in the requested zone', () => {
  const parts = clockParts(NOW, 'de-DE', 'Europe/Berlin');
  assert.equal(parts.time, '22:41');
  assert.equal(parts.period, null);
  assert.match(parts.date, /Freitag/);
});

// --- burn-in care --------------------------------------------------------------------

test('drift: never strays more than the maximum from the center', () => {
  for (let t = 0; t < 3 * DRIFT_CYCLE_MS; t += 997) {
    const { x, y } = driftOffset(t);
    assert.ok(Math.hypot(x, y) <= DRIFT_MAX_PX + 0.1, `t=${t} -> ${x},${y}`);
  }
});

test('drift: moves, and repeats every cycle', () => {
  assert.notDeepEqual(driftOffset(0), driftOffset(DRIFT_CYCLE_MS / 4));
  assert.deepEqual(driftOffset(12_345), driftOffset(12_345 + DRIFT_CYCLE_MS));
});

test('drift: covers both axes (a circle, not a line)', () => {
  const quarter = driftOffset(DRIFT_CYCLE_MS / 4);
  assert.ok(Math.abs(quarter.x) > 5 && Math.abs(quarter.y) < 1);
  const start = driftOffset(0);
  assert.ok(Math.abs(start.y) > 5 && Math.abs(start.x) < 1);
});

test('dim: full brightness with a stream, or before ten idle minutes', () => {
  assert.equal(idleDim(null, NOW), 1);
  assert.equal(idleDim(NOW, NOW), 1);
  assert.equal(idleDim(NOW - DIM_AFTER_MS, NOW), 1);
});

test('dim: eases down to 70% over the ramp and stays there', () => {
  assert.equal(idleDim(NOW - DIM_AFTER_MS - DIM_RAMP_MS / 2, NOW), 0.85);
  assert.equal(idleDim(NOW - DIM_AFTER_MS - DIM_RAMP_MS, NOW), DIM_LEVEL);
  assert.equal(idleDim(NOW - 6 * 3600 * S, NOW), DIM_LEVEL);
});

// --- intermission loop ---------------------------------------------------------------

test('slides: the index wraps, and a single slide or none stays put', () => {
  assert.equal(nextSlide(0, 3), 1);
  assert.equal(nextSlide(2, 3), 0);
  assert.equal(nextSlide(0, 1), 0);
  assert.equal(nextSlide(0, 0), 0);
});

test('slides: a list that shrank under the index lands back in range', () => {
  assert.ok(nextSlide(7, 3) < 3);
});

test('titles: five episodes of one show are one poster, case and spacing aside', () => {
  const items = [
    { title: 'Severance', n: 1 },
    { title: 'severance ', n: 2 },
    { title: 'Heat', n: 3 },
    { title: 'Severance', n: 4 },
    { title: 'Arrival', n: 5 },
  ];
  assert.deepEqual(uniqueTitles(items, 10).map((i) => i.n), [1, 3, 5]);
});

test('titles: honours the limit and copes with nothing', () => {
  const items = ['a', 'b', 'c', 'd'].map((title) => ({ title }));
  assert.equal(uniqueTitles(items, 2).length, 2);
  assert.deepEqual(uniqueTitles([], 5), []);
});

// --- relative age --------------------------------------------------------------------

const DAY = 86_400_000;

test('age: today, yesterday and days read naturally in English', () => {
  assert.equal(relativeAge(NOW - 3600 * S, NOW, 'en-US'), 'today');
  assert.equal(relativeAge(NOW - DAY, NOW, 'en-US'), 'yesterday');
  assert.equal(relativeAge(NOW - 3 * DAY, NOW, 'en-US'), '3 days ago');
});

test('age: weeks, months and years', () => {
  assert.equal(relativeAge(NOW - 14 * DAY, NOW, 'en-US'), '2 weeks ago');
  assert.equal(relativeAge(NOW - 90 * DAY, NOW, 'en-US'), '3 months ago');
  assert.equal(relativeAge(NOW - 800 * DAY, NOW, 'en-US'), '2 years ago');
});

test('age: German is phrased by Intl, plurals included', () => {
  assert.equal(relativeAge(NOW - DAY, NOW, 'de-DE'), 'gestern');
  assert.equal(relativeAge(NOW - 3 * DAY, NOW, 'de-DE'), 'vor 3 Tagen');
});

test('age: a date in the future is today, not "in 2 days"', () => {
  assert.equal(relativeAge(NOW + 2 * DAY, NOW, 'en-US'), 'today');
});

// --- installable app -----------------------------------------------------------------

test('manifest: installable (start url, standalone, dark colors)', () => {
  const m = manifest();
  assert.equal(m.name, 'Watcharr');
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.background_color, '#08090b');
  assert.equal(m.theme_color, '#08090b');
});

test('manifest: 192 and 512 icons, plus a separate maskable 512', () => {
  const icons = manifest().icons ?? [];
  const has = (sizes: string, purpose: string) =>
    icons.some((i) => i.sizes === sizes && i.purpose === purpose && i.type === 'image/png');
  assert.ok(has('192x192', 'any'));
  assert.ok(has('512x512', 'any'));
  assert.ok(has('512x512', 'maskable'));
  // One image must never serve both purposes: a maskable icon needs the safe-zone art.
  assert.equal(icons.filter((i) => i.purpose === 'maskable' && i.src === '/icon/any-512').length, 0);
});

test('manifest: every shortcut is a same-origin path', () => {
  const shortcuts = manifest().shortcuts ?? [];
  assert.ok(shortcuts.length >= 2);
  for (const shortcut of shortcuts) assert.match(shortcut.url, /^\/[a-z]/);
});

if (failed > 0) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall screen tests passed');
