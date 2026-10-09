// Run: npx tsx src/test/insights.test.ts
// The insight rules and the achievement table are pure, so this needs no database.
// Berlin because its DST changes fall on the dates the boundary cases below use.
process.env.TZ = 'Europe/Berlin';

import assert from 'node:assert/strict';
import {
  ACHIEVEMENT_TIERS,
  chronotypeOf,
  computeAchievements,
  computeCustomAchievements,
  levelOf,
  levelStart,
  parseTiers,
  validateCustomBadge,
  computeInsights,
  localDayOf,
  type Achievement,
  type AchievementId,
  type CustomBadgeDef,
  type Insight,
  type PlayRow,
} from '../server/insights-core';

let failed = 0;
function check(name: string, run: () => void) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${(error as Error).message}`);
  }
}

let seq = 0;
function play(day: string, over: Partial<PlayRow> = {}): PlayRow {
  seq += 1;
  return {
    userId: 1,
    itemId: `item-${seq}`,
    title: `Title ${seq}`,
    show: null,
    mediaType: 'movie',
    year: 2020,
    day,
    hour: 20,
    genres: [],
    durationMs: 3_600_000,
    ...over,
  };
}
const episode = (day: string, show: string, over: Partial<PlayRow> = {}) =>
  play(day, { mediaType: 'episode', show, ...over });

const NOW = new Date(2026, 9, 9, 12, 0); // Fri 2026-10-09, local
const insight = <K extends Insight['kind']>(list: Insight[], kind: K) =>
  list.find((i): i is Extract<Insight, { kind: K }> => i.kind === kind);
const ach = (list: Achievement[], id: AchievementId) => list.find((a) => a.id === id)!;

/** `n` consecutive days from `start` (UTC math, so DST cannot move a day). */
function days(start: string, n: number): string[] {
  const base = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(base + i * 86_400_000).toISOString().slice(0, 10));
}

// --- empty and tiny inputs -----------------------------------------------------------------

check('empty input: no insights, every achievement locked at zero', () => {
  assert.deepEqual(computeInsights([], NOW), []);
  const all = computeAchievements([]);
  assert.equal(all.length, Object.keys(ACHIEVEMENT_TIERS).length);
  assert.equal(new Set(all.map((a) => a.id)).size, all.length);
  for (const a of all) {
    assert.equal(a.unlocked, false);
    assert.equal(a.tier, 0);
    assert.equal(a.progress, 0);
    assert.equal(a.value, 0);
    assert.ok(Number.isFinite(a.target) && a.target > 0);
  }
});

check('one play: nothing to say, first badge earned, the next one in sight', () => {
  const one = [play('2026-10-08')];
  assert.deepEqual(computeInsights(one, NOW), []);
  const plays = ach(computeAchievements(one), 'plays');
  assert.equal(plays.tier, 1);
  assert.equal(plays.unlocked, true);
  assert.equal(plays.target, 10);
  assert.equal(plays.progress, 0.1);
  assert.equal(computeAchievements(one).filter((a) => a.unlocked).length, 1);
});

// --- chronotype ----------------------------------------------------------------------------

check('chronotype windows cover the clock without gaps', () => {
  const expected: Record<number, string> = {
    0: 'night', 4: 'night', 5: 'early', 10: 'early', 11: 'daylight', 16: 'daylight',
    17: 'prime', 22: 'prime', 23: 'night',
  };
  for (const [hour, type] of Object.entries(expected)) {
    assert.equal(chronotypeOf(Number(hour)), type, `hour ${hour}`);
  }
});

check('chronotype: clear winner with its share', () => {
  const plays = [
    ...Array.from({ length: 15 }, (_, i) => play(`2026-09-${String(i + 1).padStart(2, '0')}`, { hour: i % 2 ? 0 : 23 })),
    ...Array.from({ length: 5 }, () => play('2026-09-20', { hour: 20 })),
  ];
  const found = insight(computeInsights(plays, NOW), 'chronotype')!;
  assert.equal(found.type, 'night');
  assert.equal(found.share, 0.75);
});

check('chronotype: needs 20 plays, and a window above 40%', () => {
  const few = Array.from({ length: 19 }, () => play('2026-09-01', { hour: 20 }));
  assert.equal(insight(computeInsights(few, NOW), 'chronotype'), undefined);
  // 6 per window is an even 25%: nobody is the owl or the bird.
  const even = [23, 6, 12, 18].flatMap((hour) => Array.from({ length: 6 }, () => play('2026-09-01', { hour })));
  assert.equal(insight(computeInsights(even, NOW), 'chronotype'), undefined);
});

check('chronotype: an exact tie is called by the fixed order (night first)', () => {
  const plays = [
    ...Array.from({ length: 10 }, () => play('2026-09-01', { hour: 20 })),
    ...Array.from({ length: 10 }, () => play('2026-09-02', { hour: 2 })),
  ];
  const found = insight(computeInsights(plays, NOW), 'chronotype')!;
  assert.equal(found.type, 'night');
  assert.equal(found.share, 0.5);
});

// --- binge ---------------------------------------------------------------------------------

check('binge: three episodes of one show in a day is the floor', () => {
  const three = ['a', 'b', 'c'].map((id) => episode('2026-08-02', 'Severance', { itemId: id }));
  const found = insight(computeInsights(three, NOW), 'binge')!;
  assert.deepEqual([found.show, found.day, found.episodes], ['Severance', '2026-08-02', 3]);
  const two = three.slice(0, 2);
  assert.equal(insight(computeInsights(two, NOW), 'binge'), undefined);
});

check('binge: a replayed episode and a movie marathon are not a binge', () => {
  const replay = Array.from({ length: 4 }, () => episode('2026-08-02', 'Andor', { itemId: 'same' }));
  assert.equal(insight(computeInsights(replay, NOW), 'binge'), undefined);
  const movies = Array.from({ length: 4 }, () => play('2026-08-02'));
  assert.equal(insight(computeInsights(movies, NOW), 'binge'), undefined);
});

check('binge: two viewers each watching two episodes is not four', () => {
  const plays = [
    episode('2026-08-02', 'Andor', { userId: 1, itemId: 'e1' }),
    episode('2026-08-02', 'Andor', { userId: 1, itemId: 'e2' }),
    episode('2026-08-02', 'Andor', { userId: 2, itemId: 'e3' }),
    episode('2026-08-02', 'Andor', { userId: 2, itemId: 'e4' }),
  ];
  assert.equal(insight(computeInsights(plays, NOW), 'binge'), undefined);
});

check('binge: a tie goes to the most recent day', () => {
  const plays = [
    ...['a', 'b', 'c'].map((id) => episode('2026-03-01', 'Old Show', { itemId: id })),
    ...['d', 'e', 'f'].map((id) => episode('2026-07-01', 'New Show', { itemId: id })),
  ];
  const found = insight(computeInsights(plays, NOW), 'binge')!;
  assert.equal(found.show, 'New Show');
});

// --- on this day ---------------------------------------------------------------------------

check('on this day: earlier years only, newest first, top title per year', () => {
  const plays = [
    play('2026-10-09', { title: 'Today' }),
    play('2025-10-09', { title: 'Heat' }),
    play('2024-10-09', { title: 'Alien' }),
    play('2024-10-09', { title: 'Dune' }),
    play('2024-10-09', { title: 'Dune', itemId: 'dune-2' }),
    play('2025-10-10', { title: 'Next day' }),
    play('2025-09-09', { title: 'Other month' }),
  ];
  const found = insight(computeInsights(plays, NOW), 'onThisDay')!;
  assert.deepEqual(
    found.entries.map((e) => [e.year, e.name, e.day]),
    [[2025, 'Heat', '2025-10-09'], [2024, 'Dune', '2024-10-09']],
  );
});

check('on this day: at most three years, an episode is named by its show', () => {
  const plays = [2025, 2024, 2023, 2022, 2021].map((year) =>
    episode(`${year}-10-09`, `Show ${year}`),
  );
  const found = insight(computeInsights(plays, NOW), 'onThisDay')!;
  assert.deepEqual(found.entries.map((e) => e.name), ['Show 2025', 'Show 2024', 'Show 2023']);
  assert.equal(found.entries[0].linkTitle, 'Show 2025');
});

check('on this day: nothing from earlier years, nothing shown', () => {
  assert.equal(insight(computeInsights([play('2026-10-09')], NOW), 'onThisDay'), undefined);
});

check('on this day: a leap day finds earlier leap days', () => {
  const leap = new Date(2028, 1, 29, 12);
  const found = insight(computeInsights([play('2024-02-29', { title: 'Leap' })], leap), 'onThisDay')!;
  assert.equal(found.entries[0].name, 'Leap');
});

// --- weekend versus weekday ----------------------------------------------------------------

/** One play every day for four weeks ending on NOW's day, with minutes depending on the day. */
function fourWeeks(minutes: (weekend: boolean) => number, only?: 'weekend' | 'weekday'): PlayRow[] {
  return days('2026-09-12', 28)
    .map((day) => {
      const weekend = [5, 6].includes((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7);
      return { day, weekend };
    })
    .filter(({ weekend }) => (only === undefined ? true : only === 'weekend' ? weekend : !weekend))
    .map(({ day, weekend }) => play(day, { durationMs: minutes(weekend) * 60_000 }));
}
const END = new Date(2026, 9, 9, 12); // 2026-09-12 + 27 days

check('weekend: double the minutes per weekend day reads as 2x, not as a weekday viewer', () => {
  const found = insight(computeInsights(fourWeeks((w) => (w ? 120 : 60)), END), 'weekend')!;
  assert.equal(found.side, 'weekend');
  assert.ok(Math.abs(found.ratio - 2) < 1e-9, String(found.ratio));
});

check('weekend: weekdays on top flips the side and keeps the ratio above 1', () => {
  const found = insight(computeInsights(fourWeeks((w) => (w ? 30 : 60)), END), 'weekend')!;
  assert.equal(found.side, 'weekday');
  assert.ok(Math.abs(found.ratio - 2) < 1e-9);
});

check('weekend: the same minutes on every day is "even", even though only 2/7 are weekend', () => {
  const found = insight(computeInsights(fourWeeks(() => 60), END), 'weekend')!;
  assert.equal(found.side, 'even');
  assert.ok(Math.abs(found.ratio - 1) < 1e-9);
});

check('weekend: omitted without both sides, under 14 days, or under 20 plays', () => {
  assert.equal(insight(computeInsights(fourWeeks(() => 60, 'weekend'), END), 'weekend'), undefined);
  assert.equal(insight(computeInsights(fourWeeks(() => 60, 'weekday'), END), 'weekend'), undefined);
  const short = fourWeeks(() => 60).slice(-13);
  const dense = short.flatMap((p) => [p, { ...p, itemId: `${p.itemId}-b` }]);
  assert.equal(insight(computeInsights(dense, END), 'weekend'), undefined);
  assert.equal(insight(computeInsights(fourWeeks(() => 60).slice(-19), END), 'weekend'), undefined);
});

// --- comfort title -------------------------------------------------------------------------

check('comfort: the most replayed item, three plays at least', () => {
  const plays = [
    ...Array.from({ length: 4 }, (_, i) => play(`2026-0${i + 1}-05`, { itemId: 'heat', title: 'Heat' })),
    ...Array.from({ length: 3 }, (_, i) => play(`2026-0${i + 1}-06`, { itemId: 'alien', title: 'Alien' })),
  ];
  const found = insight(computeInsights(plays, NOW), 'comfort')!;
  assert.deepEqual([found.name, found.count], ['Heat', 4]);
  const two = Array.from({ length: 2 }, () => play('2026-05-05', { itemId: 'x' }));
  assert.equal(insight(computeInsights(two, NOW), 'comfort'), undefined);
});

check('comfort: different episodes of a show are not replays; a replayed episode is', () => {
  const marathon = ['a', 'b', 'c', 'd'].map((id) => episode('2026-05-05', 'Andor', { itemId: id }));
  assert.equal(insight(computeInsights(marathon, NOW), 'comfort'), undefined);
  const replay = Array.from({ length: 3 }, (_, i) =>
    episode(`2026-05-0${i + 1}`, 'The Bear', { itemId: 'pilot', title: 'System' }),
  );
  const found = insight(computeInsights(replay, NOW), 'comfort')!;
  assert.equal(found.name, 'The Bear · System');
  assert.equal(found.linkTitle, 'The Bear');
});

check('comfort: a tie goes to the one played most recently', () => {
  const plays = [
    ...Array.from({ length: 3 }, () => play('2026-01-05', { itemId: 'a', title: 'Older' })),
    ...Array.from({ length: 3 }, () => play('2026-06-05', { itemId: 'b', title: 'Newer' })),
  ];
  assert.equal(insight(computeInsights(plays, NOW), 'comfort')!.name, 'Newer');
});

// --- momentum ------------------------------------------------------------------------------

check('momentum: window edges are exact (day 29 is this period, day 30 the last)', () => {
  const at = (age: number) => days('2026-08-01', 70)[days('2026-08-01', 70).indexOf('2026-10-09') - age];
  const plays = [
    play(at(0)), play(at(29)), // current
    play(at(30)), play(at(45)), play(at(59)), // previous
    play(at(60)), // too old for either
  ];
  const found = insight(computeInsights(plays, NOW), 'momentum')!;
  assert.deepEqual([found.current, found.previous, found.changePct], [2, 3, -33]);
});

check('momentum: omitted when the previous window is thin or empty', () => {
  const recent = Array.from({ length: 10 }, () => play('2026-10-01'));
  assert.equal(insight(computeInsights(recent, NOW), 'momentum'), undefined);
  const thin = [...recent, play('2026-08-20'), play('2026-08-21')];
  assert.equal(insight(computeInsights(thin, NOW), 'momentum'), undefined);
});

check('momentum: growth in percent, plays dated tomorrow ignored', () => {
  const plays = [
    ...Array.from({ length: 6 }, () => play('2026-10-01')),
    ...Array.from({ length: 3 }, () => play('2026-09-01')),
    play('2026-10-10'),
  ];
  const found = insight(computeInsights(plays, NOW), 'momentum')!;
  assert.deepEqual([found.current, found.previous, found.changePct], [6, 3, 100]);
});

check('momentum: the 30-day windows hold across the October DST change', () => {
  // Berlin leaves summer time on 2026-10-25; a local-midnight diff would put day 30 at 29.96.
  const now = new Date(2026, 9, 25, 0, 30);
  assert.equal(localDayOf(now), '2026-10-25');
  const plays = [
    play('2026-09-26'), play('2026-09-26'), // age 29 -> current
    play('2026-09-25'), play('2026-09-25'), play('2026-09-25'), // age 30 -> previous
  ];
  const found = insight(computeInsights(plays, now), 'momentum')!;
  assert.deepEqual([found.current, found.previous], [2, 3]);
});

// --- ranking -------------------------------------------------------------------------------

check('ranking: at most four, best first, scores between 0 and 1, stable on equal scores', () => {
  const plays = [
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => episode('2026-09-02', 'Severance', { itemId: id, hour: 1 })),
    ...Array.from({ length: 5 }, (_, i) => play(`2026-09-1${i}`, { itemId: 'heat', title: 'Heat', hour: 1 })),
    ...Array.from({ length: 25 }, (_, i) => play(days('2026-08-01', 25)[i], { hour: 2 })),
    play('2025-10-09', { title: 'Last year' }),
  ];
  const list = computeInsights(plays, NOW);
  assert.ok(list.length <= 4 && list.length >= 3);
  for (let i = 1; i < list.length; i += 1) assert.ok(list[i - 1].score >= list[i].score);
  for (const item of list) assert.ok(item.score >= 0 && item.score <= 1);
  // A near-total night owl (0.9) edges out a lone memory (0.8); both make the cut.
  assert.equal(list[0].kind, 'chronotype');
  assert.ok(list.some((i) => i.kind === 'onThisDay'));
  assert.deepEqual(computeInsights(plays, NOW), list);
  assert.equal(computeInsights(plays, NOW, 2).length, 2);
});

// --- achievements --------------------------------------------------------------------------

check('achievements: tiers, progress to the next tier, maxed tiers read 1', () => {
  const at = (n: number) => computeAchievements(Array.from({ length: n }, () => play('2026-05-05')));
  assert.deepEqual([ach(at(9), 'plays').tier, ach(at(9), 'plays').target, ach(at(9), 'plays').progress], [1, 10, 0.9]);
  assert.equal(ach(at(10), 'plays').tier, 2);
  assert.equal(ach(at(100), 'plays').tier, 3);
  const near = ach(at(1000), 'plays');
  assert.deepEqual([near.tier, near.tiers, near.target], [5, 6, 5000]);
  const top = ach(at(5000), 'plays');
  assert.deepEqual([top.tier, top.tiers, top.progress, top.target], [6, 6, 1, 5000]);
});

check('achievements: invariants hold for a busy mixed history', () => {
  const plays = days('2026-01-01', 200).flatMap((day, i) => [
    play(day, { hour: i % 24, genres: [`g${i % 20}`] }),
    episode(day, `Show ${i % 7}`, { hour: (i * 5) % 24, year: 1980 + (i % 40) }),
  ]);
  for (const a of computeAchievements(plays)) {
    assert.ok(a.progress >= 0 && a.progress <= 1, a.id);
    assert.ok(a.tier >= 0 && a.tier <= a.tiers, a.id);
    assert.equal(a.unlocked, a.tier > 0, a.id);
    assert.equal(a.tiers, ACHIEVEMENT_TIERS[a.id as AchievementId].length, a.id);
    assert.equal(a.progress === 1, a.tier === a.tiers || a.value >= a.target, a.id);
  }
});

check('streak: the longest run ever, across a month end and a leap day', () => {
  const run = (list: string[]) => ach(computeAchievements(list.map((d) => play(d))), 'streak');
  assert.equal(run(['2026-01-30', '2026-01-31', '2026-02-01']).value, 3);
  assert.equal(run(['2024-02-28', '2024-02-29', '2024-03-01']).value, 3);
  assert.equal(run(['2026-12-31', '2027-01-01']).value, 2);
});

check('streak: a gap resets the run, duplicates on a day do not extend it', () => {
  const list = ['2026-03-01', '2026-03-02', '2026-03-02', '2026-03-02', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07'];
  const streak = ach(computeAchievements(list.map((d) => play(d))), 'streak');
  assert.equal(streak.value, 4);
  assert.equal(streak.tier, 1);
});

check('streak: DST changes do not break a run (EU 2026-03-29, US 2026-03-08)', () => {
  const run = (list: string[]) => ach(computeAchievements(list.map((d) => play(d))), 'streak').value;
  assert.equal(run(['2026-03-28', '2026-03-29', '2026-03-30']), 3);
  assert.equal(run(['2026-03-07', '2026-03-08', '2026-03-09']), 3);
  assert.equal(run(['2026-10-24', '2026-10-25', '2026-10-26']), 3);
});

check('midnight: hour 0 counts for the night owl, 23:xx does not, 05:00 is early bird', () => {
  const night = (hours: number[]) =>
    ach(computeAchievements(hours.map((hour) => play('2026-05-05', { hour }))), 'nightOwl').value;
  assert.equal(night([0, 4]), 2);
  assert.equal(night([23, 5]), 0);
  const early = (hours: number[]) =>
    ach(computeAchievements(hours.map((hour) => play('2026-05-05', { hour }))), 'earlyBird').value;
  assert.equal(early([4, 5, 7, 8]), 2);
  // 23:59 and 00:01 are different days: the same-day rules must not merge them.
  const split = [play('2026-05-05', { hour: 23 }), play('2026-05-06', { hour: 0 })];
  assert.equal(ach(computeAchievements(split), 'streak').value, 2);
});

check('marathoner: hours in one day for one viewer; two viewers do not add up', () => {
  const six = [play('2026-05-05', { durationMs: 3 * 3_600_000 }), play('2026-05-05', { durationMs: 3 * 3_600_000 })];
  assert.equal(ach(computeAchievements(six), 'marathoner').tier, 1);
  const two = [play('2026-05-05', { userId: 1, durationMs: 3 * 3_600_000 }), play('2026-05-05', { userId: 2, durationMs: 3 * 3_600_000 })];
  const shared = ach(computeAchievements(two), 'marathoner');
  assert.equal(shared.tier, 0);
  assert.equal(shared.value, 3);
  assert.equal(shared.progress, 0.5);
});

check('binge boss, rewatcher, cinephile and explorer', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((id) => episode('2026-05-05', 'Andor', { itemId: id }));
  assert.equal(ach(computeAchievements(five), 'binge').tier, 1);
  const replay = Array.from({ length: 5 }, (_, i) => play(`2026-05-0${i + 1}`, { itemId: 'heat' }));
  assert.equal(ach(computeAchievements(replay), 'rewatcher').tier, 1);
  // The same movie 60 times is one movie.
  const same = Array.from({ length: 60 }, () => play('2026-05-05', { itemId: 'heat' }));
  assert.equal(ach(computeAchievements(same), 'cinephile').value, 1);
  const fifty = Array.from({ length: 50 }, (_, i) => play('2026-05-05', { itemId: `m${i}` }));
  assert.equal(ach(computeAchievements(fifty), 'cinephile').tier, 1);
  // Genres are compared without case or padding, empties ignored.
  const genres = [play('2026-05-05', { genres: ['Sci-Fi', 'sci-fi ', 'Drama', ''] })];
  assert.equal(ach(computeAchievements(genres), 'explorer').value, 2);
  const eight = [play('2026-05-05', { genres: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] })];
  assert.equal(ach(computeAchievements(eight), 'explorer').tier, 1);
});

check('hours, regular, weekend warrior', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => play(days('2025-01-01', 100)[i], { durationMs: 3_600_000 }));
  const all = computeAchievements(hundred);
  assert.equal(ach(all, 'hours').tier, 1);
  assert.equal(ach(all, 'regular').tier, 2);
  // 2026-10-10 is a Saturday, 2026-10-09 a Friday.
  const weekend = Array.from({ length: 25 }, () => play('2026-10-10'));
  assert.equal(ach(computeAchievements(weekend), 'weekendWarrior').tier, 1);
  const friday = Array.from({ length: 25 }, () => play('2026-10-09'));
  assert.equal(ach(computeAchievements(friday), 'weekendWarrior').value, 0);
});

check('playful badges: double feature, time traveler, Friday the 13th', () => {
  const double = [play('2026-05-05', { itemId: 'm1' }), play('2026-05-05', { itemId: 'm2' })];
  assert.equal(ach(computeAchievements(double), 'doubleFeature').tier, 1);
  const sameMovie = [play('2026-05-05', { itemId: 'm1' }), play('2026-05-05', { itemId: 'm1' })];
  assert.equal(ach(computeAchievements(sameMovie), 'doubleFeature').tier, 0);
  const otherViewers = [play('2026-05-05', { userId: 1, itemId: 'm1' }), play('2026-05-05', { userId: 2, itemId: 'm2' })];
  assert.equal(ach(computeAchievements(otherViewers), 'doubleFeature').tier, 0);

  const decades = [1982, 1995, 2004, 2016, 2024, null].map((year) => play('2026-05-05', { year }));
  const traveler = ach(computeAchievements(decades), 'timeTraveler');
  assert.deepEqual([traveler.value, traveler.tier], [5, 1]);

  // 2026-02-13 is a Friday; 2026-10-13 is a Tuesday.
  assert.equal(ach(computeAchievements([play('2026-02-13')]), 'friday13').unlocked, true);
  assert.equal(ach(computeAchievements([play('2026-10-13')]), 'friday13').unlocked, false);
});

check('newer badges: shows, deep dive, triple feature, busy day, weeks, classics, lunch, festive, leap day', () => {
  const eps = Array.from({ length: 10 }, (_, i) => episode('2026-05-05', 'Andor', { itemId: `e${i}` }));
  const a = computeAchievements([...eps, episode('2026-05-06', 'Severance')]);
  assert.equal(ach(a, 'seriesFan').value, 2);
  assert.equal(ach(a, 'deepDive').value, 1);
  assert.equal(ach(a, 'busyDay').value, 10);
  assert.equal(ach(a, 'busyDay').tier, 2);
  // Movies do not count as shows; the same viewer's day is what busies a day.
  const two = [play('2026-05-05', { userId: 1 }), play('2026-05-05', { userId: 2 })];
  assert.equal(ach(computeAchievements(two), 'busyDay').value, 1);

  const triple = ['a', 'b', 'c'].map((id) => play('2026-05-05', { itemId: id }));
  assert.equal(ach(computeAchievements(triple), 'tripleFeature').tier, 1);

  // Monday 2026-05-04 and Sunday 2026-05-10 are one week, Monday the 11th the next.
  const weeks = ['2026-05-04', '2026-05-10', '2026-05-11'].map((d) => play(d));
  assert.equal(ach(computeAchievements(weeks), 'weeklyHabit').value, 2);

  const old = [play('2026-05-05', { itemId: 'm1', year: 1979 }), play('2026-05-05', { itemId: 'm2', year: 1980 }), episode('2026-05-05', 'Old Show', { year: 1970 })];
  assert.equal(ach(computeAchievements(old), 'classics').value, 1);

  // Hours 12 and 13 on a weekday count; the weekend and 14:00 do not.
  const lunch = [play('2026-10-09', { hour: 12 }), play('2026-10-09', { hour: 13 }), play('2026-10-09', { hour: 14 }), play('2026-10-10', { hour: 12 })];
  assert.equal(ach(computeAchievements(lunch), 'lunchBreak').value, 2);

  const festive = ['2025-12-24', '2025-12-25', '2025-12-27', '2026-01-01'].map((d) => play(d));
  assert.equal(ach(computeAchievements(festive), 'festive').value, 3);
  assert.equal(ach(computeAchievements([play('2024-02-29')]), 'leapDay').unlocked, true);
  assert.equal(ach(computeAchievements([play('2026-02-28')]), 'leapDay').unlocked, false);
});

check('level: tiers are worth the same, thresholds grow, the top is capped', () => {
  assert.deepEqual([1, 2, 3, 10].map(levelStart), [0, 20, 60, 900]);
  const fresh = levelOf(computeAchievements([]));
  assert.deepEqual([fresh.level, fresh.xp, fresh.to, fresh.progress], [1, 0, 20, 0]);
  // One play = one tier on one badge = 10 XP, halfway to level 2.
  const first = levelOf(computeAchievements([play('2026-05-05')]));
  assert.deepEqual([first.level, first.xp, first.progress], [1, 10, 0.5]);
  const capped = levelOf([{ id: 'x', tier: 500, tiers: 500, unlocked: true, progress: 1, value: 0, target: 1 }]);
  assert.deepEqual([capped.level, capped.to, capped.progress], [10, null, 1]);
});

check('custom badges: genre and text filters, metrics, tiers', () => {
  const def = (over: Partial<CustomBadgeDef>): CustomBadgeDef => ({
    id: 7, name: 'Horror Fan', description: '', icon: 'x', metric: 'plays', filter: 'genre', filterValue: 'horror', tiers: [2, 4], ...over,
  });
  const plays = [
    play('2026-05-05', { itemId: 'a', genres: ['Horror', 'Drama'] }),
    play('2026-05-06', { itemId: 'b', genres: [' horror '] }),
    play('2026-05-06', { itemId: 'c', genres: ['Comedy'], durationMs: 7_200_000 }),
  ];
  const [horror] = computeCustomAchievements(plays, [def({})]);
  assert.deepEqual([horror.id, horror.value, horror.tier, horror.target, horror.custom?.name], ['c7', 2, 1, 4, 'Horror Fan']);
  const [days] = computeCustomAchievements(plays, [def({ metric: 'days', filter: 'none', tiers: [2] })]);
  assert.deepEqual([days.value, days.tier], [2, 1]);
  const [hours] = computeCustomAchievements(plays, [def({ metric: 'hours', filter: 'genre', filterValue: 'comedy', tiers: [1, 2] })]);
  assert.deepEqual([hours.value, hours.tier], [2, 2]);
  // Text matches the show name or the title, case-insensitively; shows count episodes only.
  const shows = [episode('2026-05-05', 'The Bear', { title: 'Pilot' }), episode('2026-05-06', 'The Bear', { title: 'Hands', itemId: 'e2' }), play('2026-05-07', { title: 'Bear Grylls' })];
  const [bear] = computeCustomAchievements(shows, [def({ filter: 'text', filterValue: 'BEAR', metric: 'shows', tiers: [1] })]);
  assert.equal(bear.value, 1);
  assert.deepEqual(computeCustomAchievements(shows, []), []);
});

check('custom badge input: tiers are parsed strictly and the form is validated', () => {
  assert.deepEqual(parseTiers('10, 1; 50 1'), [1, 10, 50]);
  for (const bad of ['', 'a', '0', '-3', '1,2,3,4,5,6,7', '1e999', '99999999']) assert.equal(parseTiers(bad), null, bad);
  const ok = validateCustomBadge({ name: ' Scary ', metric: 'plays', filter: 'genre', filterValue: 'Horror', tiers: '1,5' });
  assert.ok(ok.ok && ok.value.name === 'Scary' && ok.value.icon.length > 0);
  const noValue = validateCustomBadge({ name: 'x', metric: 'plays', filter: 'text', filterValue: '', tiers: '1' });
  assert.equal(noValue.ok, false);
  assert.equal(validateCustomBadge({ name: 'x', metric: 'bogus', tiers: '1' }).ok, false);
  assert.equal(validateCustomBadge({ name: '', metric: 'plays', tiers: '1' }).ok, false);
  assert.equal(validateCustomBadge({ name: 'x', metric: 'plays', tiers: '1', icon: '<b>' }).ok, false);
  // No filter drops a stale filter value.
  const none = validateCustomBadge({ name: 'x', metric: 'plays', filter: 'none', filterValue: 'junk', tiers: '1' });
  assert.ok(none.ok && none.value.filterValue === '');
});

check('local day: just before and after midnight, on a DST night', () => {
  assert.equal(localDayOf(new Date(2026, 2, 28, 23, 59)), '2026-03-28');
  assert.equal(localDayOf(new Date(2026, 2, 29, 0, 1)), '2026-03-29');
  assert.equal(localDayOf(new Date(2026, 9, 25, 23, 59)), '2026-10-25');
  assert.equal(localDayOf(new Date(2027, 0, 1, 0, 0)), '2027-01-01');
});

if (failed > 0) {
  console.log(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log('\nall insights cases passed');
