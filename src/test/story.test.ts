import assert from 'node:assert/strict';
import {
  buildSlides,
  dayPart,
  cardText,
  parseYear,
  type StoryInput,
  type StoryTitle,
} from '../server/wrapped-story-core';

let failed = 0;
function test(name: string, run: () => void) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n${error instanceof Error ? error.stack : error}`);
  }
}

const title = (label: string, poster: string | null = `/api/art/s/${label}`): StoryTitle => ({
  label,
  plays: 12,
  minutes: 600,
  poster,
});

const rich = (): StoryInput => ({
  year: 2026,
  name: 'mara',
  plays: 320,
  watchtimeMs: 214 * 3_600_000,
  distinctTitles: 41,
  longestStreak: 9,
  topTitle: title('Severance'),
  topShow: title('Severance'),
  topMovie: title('Arrival'),
  topGenre: { label: 'Sci-Fi', share: 38 },
  busiestDay: { day: '2026-03-14', minutes: 580 },
  weekdayMinutes: [10, 20, 30, 40, 90, 60, 20],
  hourPlays: Array.from({ length: 24 }, (_, hour) => (hour === 21 ? 50 : 3)),
});

const kinds = (input: StoryInput) => buildSlides(input).map((slide) => slide.kind);
const now = new Date(2026, 9, 9);

test('a rich year plays every slide in the documented order', () => {
  assert.deepEqual(kinds(rich()), [
    'intro', 'time', 'plays', 'top', 'versus', 'genre', 'days', 'when', 'outro',
  ]);
});

test('no plays means no story at all', () => {
  assert.deepEqual(buildSlides({ ...rich(), plays: 0 }), []);
});

test('the intro carries the year and the name, the outro only the year', () => {
  const slides = buildSlides(rich());
  assert.deepEqual(slides[0], { kind: 'intro', year: 2026, name: 'mara' });
  assert.deepEqual(slides.at(-1), { kind: 'outro', year: 2026 });
});

test('watch time rounds to hours and adds days only from two full days', () => {
  const time = buildSlides(rich()).find((s) => s.kind === 'time');
  assert.deepEqual(time, { kind: 'time', value: 214, unit: 'hours', days: 9 });
  const short = buildSlides({ ...rich(), watchtimeMs: 30 * 3_600_000 }).find((s) => s.kind === 'time');
  assert.equal(short?.kind === 'time' && short.days, null);
});

test('under an hour the time slide counts minutes, under a minute it is skipped', () => {
  const minutes = buildSlides({ ...rich(), watchtimeMs: 20 * 60_000 }).find((s) => s.kind === 'time');
  assert.deepEqual(minutes, { kind: 'time', value: 20, unit: 'minutes', days: null });
  assert.ok(!kinds({ ...rich(), watchtimeMs: 59_999 }).includes('time'));
  assert.ok(!kinds({ ...rich(), watchtimeMs: 0 }).includes('time'));
});

test('show versus movie needs both sides', () => {
  assert.ok(!kinds({ ...rich(), topMovie: null }).includes('versus'));
  assert.ok(!kinds({ ...rich(), topShow: null }).includes('versus'));
});

test('a title without artwork stays a slide, just without a poster', () => {
  const top = buildSlides({ ...rich(), topTitle: title('Heat', null) }).find((s) => s.kind === 'top');
  assert.equal(top?.kind === 'top' && top.poster, null);
  assert.ok(!kinds({ ...rich(), topTitle: null }).includes('top'));
});

test('a genre needs a positive share', () => {
  assert.ok(!kinds({ ...rich(), topGenre: null }).includes('genre'));
  assert.ok(!kinds({ ...rich(), topGenre: { label: 'Drama', share: 0 } }).includes('genre'));
});

test('days slide: a streak of one is not a streak, no busiest day still keeps a streak', () => {
  const noStreak = buildSlides({ ...rich(), longestStreak: 1 }).find((s) => s.kind === 'days');
  assert.deepEqual(noStreak && noStreak.kind === 'days' && noStreak.streak, null);
  const noBusiest = buildSlides({ ...rich(), busiestDay: null }).find((s) => s.kind === 'days');
  assert.deepEqual(noBusiest && noBusiest.kind === 'days' && noBusiest.busiest, null);
  assert.ok(!kinds({ ...rich(), longestStreak: 1, busiestDay: null }).includes('days'));
  assert.ok(!kinds({ ...rich(), longestStreak: 0, busiestDay: { day: '2026-01-02', minutes: 0 } }).includes('days'));
});

test('when slide picks the peak hour and weekday, first one on a tie', () => {
  const when = buildSlides(rich()).find((s) => s.kind === 'when');
  assert.ok(when && when.kind === 'when');
  assert.equal(when.hour, 21);
  assert.equal(when.weekday, 4);
  assert.equal(when.part, 'evening');
  assert.equal(when.hours.length, 24);
  const tied = buildSlides({
    ...rich(),
    hourPlays: Array.from({ length: 24 }, () => 5),
    weekdayMinutes: [7, 7, 7, 7, 7, 7, 7],
  }).find((s) => s.kind === 'when');
  assert.ok(tied && tied.kind === 'when' && tied.hour === 0 && tied.weekday === 0);
});

test('when slide is skipped without any hour or weekday data', () => {
  assert.ok(!kinds({ ...rich(), hourPlays: Array.from({ length: 24 }, () => 0) }).includes('when'));
  assert.ok(!kinds({ ...rich(), weekdayMinutes: [0, 0, 0, 0, 0, 0, 0] }).includes('when'));
});

test('a sparse year (one movie play) still gets intro, plays and outro', () => {
  const sparse: StoryInput = {
    year: 2026,
    name: 'x',
    plays: 1,
    watchtimeMs: 0,
    distinctTitles: 1,
    longestStreak: 1,
    topTitle: null,
    topShow: null,
    topMovie: null,
    topGenre: null,
    busiestDay: null,
    weekdayMinutes: [0, 0, 0, 0, 0, 0, 0],
    hourPlays: Array.from({ length: 24 }, () => 0),
  };
  assert.deepEqual(kinds(sparse), ['intro', 'plays', 'outro']);
});

test('day parts change at 5, 12, 17 and 22', () => {
  const parts = [0, 4, 5, 11, 12, 16, 17, 21, 22, 23].map(dayPart);
  assert.deepEqual(parts, [
    'night', 'night', 'morning', 'morning', 'afternoon', 'afternoon',
    'evening', 'evening', 'night', 'night',
  ]);
});

test('parseYear accepts a four digit year in range', () => {
  assert.equal(parseYear('2025', now), 2025);
  assert.equal(parseYear('1970', now), 1970);
  assert.equal(parseYear('2027', now), 2027);
});

test('parseYear falls back to the current year for anything else', () => {
  for (const bad of [undefined, null, '', 'abc', '1.5', '-2025', '99999', '1969', '2028', '2025 OR 1=1', '２０２５', ' 2025']) {
    assert.equal(parseYear(bad, now), 2026, `input ${JSON.stringify(bad)}`);
  }
});

test('parseYear takes the first of a repeated parameter', () => {
  assert.equal(parseYear(['2024', '2023'], now), 2024);
  assert.equal(parseYear(['x', '2023'], now), 2026);
});

test('cardText keeps Latin text and drops what the card font cannot draw', () => {
  assert.equal(cardText('Dune: Part Two'), 'Dune: Part Two');
  assert.equal(cardText('Amélie 🎬'), 'Amélie');
  assert.equal(cardText('🎬 映画'), '\u2014');
  assert.equal(cardText('  a   b  '), 'a b');
  assert.equal(Array.from(cardText('x'.repeat(200))).length, 60);
  assert.ok(cardText('x'.repeat(200)).endsWith('\u2026'));
});

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('all story tests passed');
