// Pure insight and achievement logic, no 'server-only' and no database, so the tests can run
// it. insights.ts loads the rows; everything that decides what is worth saying lives here.
//
// All days are local calendar days as 'YYYY-MM-DD' strings and all hours are local (SQLite's
// 'localtime', the same convention as stats.ts). Day arithmetic goes through UTC day numbers
// on purpose: a local-midnight difference is 23 or 25 hours across a DST change.

/** One play, reduced to what the insights need. */
export interface PlayRow {
  userId: number;
  itemId: string;
  title: string;
  /** Show name for an episode, null for a movie. */
  show: string | null;
  mediaType: string;
  year: number | null;
  day: string;
  hour: number;
  genres: string[];
  durationMs: number;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
/** Monday = 0, like the weekday grid elsewhere in the app. 1970-01-01 was a Thursday. */
const weekdayOf = (day: string): number => (((dayNumber(day) + 3) % 7) + 7) % 7;
const isWeekend = (day: string): boolean => weekdayOf(day) >= 5;

/** The viewer's local calendar day for an instant. */
export function localDayOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const label = (play: PlayRow): string => play.show ?? play.title;

// ---------------------------------------------------------------------------------------------
// Shared measures
// ---------------------------------------------------------------------------------------------

interface Binge {
  show: string;
  day: string;
  episodes: number;
}

/**
 * The most episodes of one show that one viewer played in one day. Distinct episodes, so
 * watching the same one twice is a replay and not a binge. Ties go to the most recent day, then
 * to the show name, so the answer does not depend on row order.
 */
function bestBinge(plays: PlayRow[]): Binge | null {
  const groups = new Map<string, { show: string; day: string; items: Set<string> }>();
  for (const play of plays) {
    if (play.mediaType !== 'episode' || !play.show) continue;
    const key = `${play.userId}|${play.show}|${play.day}`;
    const group = groups.get(key) ?? { show: play.show, day: play.day, items: new Set() };
    group.items.add(play.itemId);
    groups.set(key, group);
  }
  let best: Binge | null = null;
  for (const { show, day, items } of groups.values()) {
    const candidate = { show, day, episodes: items.size };
    if (
      !best ||
      candidate.episodes > best.episodes ||
      (candidate.episodes === best.episodes &&
        (candidate.day > best.day || (candidate.day === best.day && candidate.show < best.show)))
    ) {
      best = candidate;
    }
  }
  return best;
}

interface Replayed {
  /** What to show: "Show · Episode" for an episode, the title for a movie. */
  name: string;
  /** What /title/<x> resolves: the show for an episode. */
  linkTitle: string;
  count: number;
}

/**
 * The item one viewer played most often. Ties go to the one played most recently, then to the
 * name. Episodes of a show are different items, so marathoning a series is not a replay.
 */
function mostReplayed(plays: PlayRow[]): Replayed | null {
  const groups = new Map<string, { play: PlayRow; count: number; last: string }>();
  for (const play of plays) {
    const key = `${play.userId}|${play.itemId}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      if (play.day > group.last) group.last = play.day;
    } else {
      groups.set(key, { play, count: 1, last: play.day });
    }
  }
  let best: { play: PlayRow; count: number; last: string } | null = null;
  for (const group of groups.values()) {
    if (
      !best ||
      group.count > best.count ||
      (group.count === best.count &&
        (group.last > best.last || (group.last === best.last && label(group.play) < label(best.play))))
    ) {
      best = group;
    }
  }
  if (!best) return null;
  const { play } = best;
  return {
    // Some servers already put the show into an episode's title.
    name: play.show && !play.title.startsWith(play.show) ? `${play.show} · ${play.title}` : play.title,
    linkTitle: label(play),
    count: best.count,
  };
}

// ---------------------------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------------------------

/**
 * Chronotype: four equal six-hour windows, so a share is comparable between them.
 *   early    05:00-10:59      daylight 11:00-16:59
 *   prime    17:00-22:59      night    23:00-04:59
 */
export type Chronotype = 'night' | 'early' | 'daylight' | 'prime';

/** Also the tie-break order: a viewer split evenly is called by the first one listed. */
const CHRONO_ORDER: Chronotype[] = ['night', 'early', 'daylight', 'prime'];

export function chronotypeOf(hour: number): Chronotype {
  if (hour >= 23 || hour < 5) return 'night';
  if (hour < 11) return 'early';
  if (hour < 17) return 'daylight';
  return 'prime';
}

/** Below these the pattern is noise: too few plays, or no window clearly ahead of an even 25%. */
const CHRONO_MIN_PLAYS = 20;
const CHRONO_MIN_SHARE = 0.4;
const BINGE_MIN = 3;
const COMFORT_MIN = 3;
const WEEKEND_MIN_PLAYS = 20;
const WEEKEND_MIN_SPAN_DAYS = 14;
/** Rate ratio from which one side counts as "more"; closer than this is "about the same". */
const WEEKEND_SKEW = 1.25;
const MOMENTUM_WINDOW = 30;
const MOMENTUM_MIN_PREVIOUS = 3;
const ON_THIS_DAY_ROWS = 3;

export type InsightKind = 'onThisDay' | 'binge' | 'comfort' | 'chronotype' | 'weekend' | 'momentum';

export interface OnThisDayEntry {
  year: number;
  /** The full day, for a link to that day's history. */
  day: string;
  name: string;
  linkTitle: string;
}

export type Insight = { score: number } & (
  | { kind: 'onThisDay'; entries: OnThisDayEntry[] }
  | { kind: 'binge'; show: string; day: string; episodes: number }
  | { kind: 'comfort'; name: string; linkTitle: string; count: number }
  | { kind: 'chronotype'; type: Chronotype; share: number }
  | { kind: 'weekend'; side: 'weekend' | 'weekday' | 'even'; ratio: number }
  | { kind: 'momentum'; current: number; previous: number; changePct: number }
);

function chronotypeInsight(plays: PlayRow[]): Insight | null {
  if (plays.length < CHRONO_MIN_PLAYS) return null;
  const counts = new Map<Chronotype, number>(CHRONO_ORDER.map((type) => [type, 0]));
  for (const play of plays) {
    const type = chronotypeOf(play.hour);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  let type = CHRONO_ORDER[0];
  for (const candidate of CHRONO_ORDER) {
    if ((counts.get(candidate) ?? 0) > (counts.get(type) ?? 0)) type = candidate;
  }
  const share = (counts.get(type) ?? 0) / plays.length;
  if (share < CHRONO_MIN_SHARE) return null;
  // 25% is what an even spread gives; 75% and up is a creature of habit.
  return { kind: 'chronotype', type, share, score: 0.9 * clamp01((share - 0.25) / 0.5) };
}

function bingeInsight(plays: PlayRow[]): Insight | null {
  const best = bestBinge(plays);
  if (!best || best.episodes < BINGE_MIN) return null;
  return { kind: 'binge', ...best, score: clamp01(best.episodes / 10) };
}

function comfortInsight(plays: PlayRow[]): Insight | null {
  const best = mostReplayed(plays);
  if (!best || best.count < COMFORT_MIN) return null;
  return { kind: 'comfort', ...best, score: clamp01(best.count / 8) };
}

function onThisDayInsight(plays: PlayRow[], today: string): Insight | null {
  const monthDay = today.slice(5);
  const thisYear = Number(today.slice(0, 4));
  // year -> title -> plays; the most played title is that year's entry.
  const byYear = new Map<number, { day: string; titles: Map<string, { play: PlayRow; n: number }> }>();
  for (const play of plays) {
    const year = Number(play.day.slice(0, 4));
    if (play.day.slice(5) !== monthDay || year >= thisYear) continue;
    const slot = byYear.get(year) ?? { day: play.day, titles: new Map() };
    const entry = slot.titles.get(label(play)) ?? { play, n: 0 };
    entry.n += 1;
    slot.titles.set(label(play), entry);
    byYear.set(year, slot);
  }
  const entries: OnThisDayEntry[] = [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, ON_THIS_DAY_ROWS)
    .map(([year, { day, titles }]) => {
      const top = [...titles.values()].sort(
        (a, b) => b.n - a.n || (label(a.play) < label(b.play) ? -1 : 1),
      )[0].play;
      return { year, day, name: label(top), linkTitle: label(top) };
    });
  if (entries.length === 0) return null;
  // A high base because it is rare and tied to today; only a lopsided habit beats it.
  return { kind: 'onThisDay', entries, score: 0.8 + 0.05 * (byYear.size > 3 ? 3 : byYear.size - 1) };
}

function weekendInsight(plays: PlayRow[], todayNumber: number): Insight | null {
  if (plays.length < WEEKEND_MIN_PLAYS) return null;
  let weekendMs = 0;
  let weekdayMs = 0;
  let first = Infinity;
  let last = todayNumber;
  for (const play of plays) {
    if (isWeekend(play.day)) weekendMs += play.durationMs;
    else weekdayMs += play.durationMs;
    const n = dayNumber(play.day);
    if (n < first) first = n;
    if (n > last) last = n;
  }
  if (weekendMs <= 0 || weekdayMs <= 0 || last - first + 1 < WEEKEND_MIN_SPAN_DAYS) return null;

  // Compare minutes per calendar day, not in total: two weekend days against five weekdays
  // would otherwise make every viewer look like a weekday watcher.
  let weekendDays = 0;
  let weekdayDays = 0;
  for (let n = first; n <= last; n += 1) {
    if ((((n + 3) % 7) + 7) % 7 >= 5) weekendDays += 1;
    else weekdayDays += 1;
  }
  if (weekendDays === 0 || weekdayDays === 0) return null;

  const ratio = weekendMs / weekendDays / (weekdayMs / weekdayDays);
  const side = ratio >= WEEKEND_SKEW ? 'weekend' : ratio <= 1 / WEEKEND_SKEW ? 'weekday' : 'even';
  const shown = ratio >= 1 ? ratio : 1 / ratio;
  // Three times as much on one side is as lopsided as it gets in practice; "even" is a footnote.
  const score = side === 'even' ? 0.1 : clamp01(Math.log(shown) / Math.log(3));
  return { kind: 'weekend', side, ratio: shown, score };
}

function momentumInsight(plays: PlayRow[], todayNumber: number): Insight | null {
  let current = 0;
  let previous = 0;
  for (const play of plays) {
    const age = todayNumber - dayNumber(play.day);
    if (age < 0) continue;
    if (age < MOMENTUM_WINDOW) current += 1;
    else if (age < MOMENTUM_WINDOW * 2) previous += 1;
  }
  if (previous < MOMENTUM_MIN_PREVIOUS) return null;
  const changePct = Math.round(((current - previous) / previous) * 100);
  return { kind: 'momentum', current, previous, changePct, score: clamp01(Math.abs(changePct) / 100) };
}

/**
 * The cards worth showing, most interesting first. The score is "how far from ordinary", 0 to 1,
 * and each rule documents its own scale above. Equal scores fall back to the fixed order of
 * `kinds`, so the result is stable. Rules without enough data return null and never appear.
 */
export function computeInsights(plays: PlayRow[], now: Date, limit = 4): Insight[] {
  if (plays.length === 0) return [];
  const today = localDayOf(now);
  const todayNumber = dayNumber(today);
  const kinds: InsightKind[] = ['onThisDay', 'binge', 'comfort', 'chronotype', 'weekend', 'momentum'];

  const found = [
    onThisDayInsight(plays, today),
    bingeInsight(plays),
    comfortInsight(plays),
    chronotypeInsight(plays),
    weekendInsight(plays, todayNumber),
    momentumInsight(plays, todayNumber),
  ].filter((insight): insight is Insight => insight !== null);

  return found
    .sort((a, b) => b.score - a.score || kinds.indexOf(a.kind) - kinds.indexOf(b.kind))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------------------------

export type AchievementId =
  | 'plays'
  | 'hours'
  | 'regular'
  | 'streak'
  | 'binge'
  | 'marathoner'
  | 'rewatcher'
  | 'cinephile'
  | 'explorer'
  | 'nightOwl'
  | 'earlyBird'
  | 'weekendWarrior'
  | 'doubleFeature'
  | 'timeTraveler'
  | 'friday13'
  | 'seriesFan'
  | 'deepDive'
  | 'tripleFeature'
  | 'busyDay'
  | 'weeklyHabit'
  | 'classics'
  | 'lunchBreak'
  | 'festive'
  | 'leapDay';

export interface Achievement {
  /** A built-in id, or `c<number>` for a badge a global admin defined. */
  id: string;
  /** Tiers reached; 0 means locked. */
  tier: number;
  tiers: number;
  unlocked: boolean;
  /** 0..1 towards the next tier (1 once the last tier is reached). */
  progress: number;
  /** The raw measure, e.g. plays so far or the longest streak in days. */
  value: number;
  /** What `progress` is measured against: the next tier's threshold, or the last one when done. */
  target: number;
  /** Only on admin-defined badges: their text and icon come from the definition, not from i18n. */
  custom?: { name: string; description: string; icon: string };
}

/** Tier thresholds per achievement, in display order. Units are in the comments. */
export const ACHIEVEMENT_TIERS: Record<AchievementId, number[]> = {
  plays: [1, 10, 100, 500, 1000, 5000], // plays
  hours: [100, 500, 1000, 2500], // hours of watch time
  regular: [30, 100, 365, 1000], // distinct active days
  streak: [3, 7, 30, 100], // longest run of consecutive days, ever
  binge: [5, 10], // distinct episodes of one show in one day
  marathoner: [6, 10], // hours in one day
  rewatcher: [5, 10, 25], // plays of one item
  cinephile: [50, 150, 500, 1000], // distinct movies
  explorer: [8, 15], // distinct genres
  nightOwl: [10, 50, 200, 1000], // plays starting 00:00-04:59
  earlyBird: [10, 50, 200], // plays starting 05:00-07:59
  weekendWarrior: [25, 100, 300, 1000], // plays on a Saturday or Sunday
  doubleFeature: [1, 10], // days with two or more distinct movies
  timeTraveler: [4, 7], // distinct decades of release years
  friday13: [1], // Fridays the 13th with a play
  seriesFan: [5, 15, 40], // distinct shows
  deepDive: [1, 3, 10], // shows with ten or more distinct episodes watched
  tripleFeature: [1, 5], // days with three or more distinct movies
  busyDay: [5, 10, 20], // plays by one viewer in one day
  weeklyHabit: [10, 26, 52], // distinct calendar weeks with a play
  classics: [3, 10, 30], // distinct movies released before 1980
  lunchBreak: [10, 50, 200], // weekday plays starting 12:00-13:59
  festive: [1, 3, 6], // distinct days among Dec 24-26, Dec 31 and Jan 1
  leapDay: [1], // a play on February 29th
};

function longestStreak(days: Set<string>): number {
  let longest = 0;
  let run = 0;
  let previous = -Infinity;
  for (const n of [...days].map(dayNumber).sort((a, b) => a - b)) {
    run = n - previous === 1 ? run + 1 : 1;
    previous = n;
    if (run > longest) longest = run;
  }
  return longest;
}

function measures(plays: PlayRow[]): Record<AchievementId, number> {
  const days = new Set<string>();
  const movies = new Set<string>();
  const genres = new Set<string>();
  const decades = new Set<number>();
  const friday13 = new Set<string>();
  const shows = new Set<string>();
  const showEpisodes = new Map<string, Set<string>>();
  const weeks = new Set<number>();
  const classics = new Set<string>();
  const festiveDays = new Set<string>();
  const leapDays = new Set<string>();
  // user|day -> ms watched / plays / distinct movies, for the marathon, busy day and features.
  const perDay = new Map<string, { ms: number; count: number; movies: Set<string> }>();
  let totalMs = 0;
  let night = 0;
  let early = 0;
  let weekend = 0;
  let lunch = 0;

  for (const play of plays) {
    days.add(play.day);
    weeks.add(Math.floor((dayNumber(play.day) + 3) / 7));
    const monthDay = play.day.slice(5);
    if (['12-24', '12-25', '12-26', '12-31', '01-01'].includes(monthDay)) festiveDays.add(play.day);
    if (monthDay === '02-29') leapDays.add(play.day);
    if ((play.hour === 12 || play.hour === 13) && !isWeekend(play.day)) lunch += 1;
    if (play.mediaType === 'episode' && play.show) {
      shows.add(play.show);
      const seen = showEpisodes.get(play.show) ?? new Set<string>();
      seen.add(play.itemId);
      showEpisodes.set(play.show, seen);
    }
    if (play.mediaType === 'movie' && play.year !== null && play.year >= 1850 && play.year < 1980) {
      classics.add(play.itemId);
    }
    totalMs += play.durationMs;
    if (play.hour < 5) night += 1;
    else if (play.hour < 8) early += 1;
    if (isWeekend(play.day)) weekend += 1;
    if (play.day.slice(8) === '13' && weekdayOf(play.day) === 4) friday13.add(play.day);
    for (const genre of play.genres) {
      const key = genre.trim().toLowerCase();
      if (key) genres.add(key);
    }
    if (play.year !== null && play.year >= 1850 && play.year <= 2200) {
      decades.add(Math.floor(play.year / 10));
    }
    const slot = perDay.get(`${play.userId}|${play.day}`) ?? { ms: 0, count: 0, movies: new Set() };
    slot.ms += play.durationMs;
    slot.count += 1;
    if (play.mediaType === 'movie') {
      movies.add(play.itemId);
      slot.movies.add(play.itemId);
    }
    perDay.set(`${play.userId}|${play.day}`, slot);
  }

  let longestDayMs = 0;
  let doubleFeatures = 0;
  let tripleFeatures = 0;
  let busiest = 0;
  for (const slot of perDay.values()) {
    if (slot.ms > longestDayMs) longestDayMs = slot.ms;
    if (slot.count > busiest) busiest = slot.count;
    if (slot.movies.size >= 2) doubleFeatures += 1;
    if (slot.movies.size >= 3) tripleFeatures += 1;
  }
  const deepShows = [...showEpisodes.values()].filter((seen) => seen.size >= 10).length;

  return {
    plays: plays.length,
    hours: totalMs / HOUR_MS,
    regular: days.size,
    streak: longestStreak(days),
    binge: bestBinge(plays)?.episodes ?? 0,
    marathoner: longestDayMs / HOUR_MS,
    rewatcher: mostReplayed(plays)?.count ?? 0,
    cinephile: movies.size,
    explorer: genres.size,
    nightOwl: night,
    earlyBird: early,
    weekendWarrior: weekend,
    doubleFeature: doubleFeatures,
    timeTraveler: decades.size,
    friday13: friday13.size,
    seriesFan: shows.size,
    deepDive: deepShows,
    tripleFeature: tripleFeatures,
    busyDay: busiest,
    weeklyHabit: weeks.size,
    classics: classics.size,
    lunchBreak: lunch,
    festive: festiveDays.size,
    leapDay: leapDays.size,
  };
}

function tierState(id: string, value: number, thresholds: number[]): Achievement {
  const tier = thresholds.filter((threshold) => value >= threshold).length;
  const done = tier === thresholds.length;
  const target = thresholds[done ? tier - 1 : tier];
  return {
    id,
    tier,
    tiers: thresholds.length,
    unlocked: tier > 0,
    progress: done ? 1 : clamp01(value / target),
    value,
    target,
  };
}

/** Every achievement, locked ones included, in display order. */
export function computeAchievements(plays: PlayRow[]): Achievement[] {
  const value = measures(plays);
  return (Object.keys(ACHIEVEMENT_TIERS) as AchievementId[]).map((id) =>
    tierState(id, value[id], ACHIEVEMENT_TIERS[id]),
  );
}

// ---------------------------------------------------------------------------------------------
// Custom badges (defined by a global admin)
// ---------------------------------------------------------------------------------------------

export const CUSTOM_METRICS = ['plays', 'hours', 'days', 'titles', 'shows'] as const;
export type CustomMetric = (typeof CUSTOM_METRICS)[number];
export const CUSTOM_FILTERS = ['none', 'genre', 'text'] as const;
export type CustomFilter = (typeof CUSTOM_FILTERS)[number];

export interface CustomBadgeDef {
  id: number;
  name: string;
  description: string;
  icon: string;
  /** What is counted: plays, hours, distinct days, distinct titles or distinct shows. */
  metric: CustomMetric;
  /** Which plays count: all, one genre, or titles/shows containing the text. */
  filter: CustomFilter;
  filterValue: string;
  tiers: number[];
}

export const MAX_CUSTOM_TIERS = 6;
export const MAX_CUSTOM_BADGES = 40;

/** "1, 10; 50" -> [1, 10, 50]; null when empty, too long, not positive or not finite. */
export function parseTiers(raw: string): number[] | null {
  const parts = raw.split(/[\s,;]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_CUSTOM_TIERS) return null;
  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isFinite(n) || n <= 0 || n > 10_000_000)) return null;
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** Checks the admin's form input; the error is a short English message for the form. */
export function validateCustomBadge(
  input: Record<string, unknown>,
): { ok: true; value: Omit<CustomBadgeDef, 'id'> } | { ok: false; error: string } {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string).trim() : '');
  const name = text('name');
  const description = text('description');
  const icon = text('icon') || '\u{1F3C5}';
  const metric = text('metric');
  const filter = text('filter') || 'none';
  const filterValue = text('filterValue');
  const tiers = parseTiers(typeof input.tiers === 'string' ? input.tiers : '');

  if (!name || name.length > 40) return { ok: false, error: 'Name is required (up to 40 characters)' };
  if (description.length > 120) return { ok: false, error: 'Description is too long (up to 120 characters)' };
  // Eight UTF-16 units fit any single emoji, including flags and skin tones.
  if (icon.length > 8 || /[\u0000-\u001f<>&]/.test(icon)) return { ok: false, error: 'Icon must be one emoji' };
  if (!(CUSTOM_METRICS as readonly string[]).includes(metric)) return { ok: false, error: 'Unknown metric' };
  if (!(CUSTOM_FILTERS as readonly string[]).includes(filter)) return { ok: false, error: 'Unknown filter' };
  if (filter !== 'none' && (!filterValue || filterValue.length > 60)) {
    return { ok: false, error: 'The filter needs a value (up to 60 characters)' };
  }
  if (!tiers) return { ok: false, error: `Levels: one to ${MAX_CUSTOM_TIERS} positive numbers, e.g. 1, 10, 50` };
  return {
    ok: true,
    value: {
      name,
      description,
      icon,
      metric: metric as CustomMetric,
      filter: filter as CustomFilter,
      filterValue: filter === 'none' ? '' : filterValue,
      tiers,
    },
  };
}

function customValue(def: CustomBadgeDef, plays: PlayRow[]): number {
  const needle = def.filterValue.trim().toLowerCase();
  const matching = plays.filter((play) => {
    if (def.filter === 'genre') return play.genres.some((genre) => genre.trim().toLowerCase() === needle);
    if (def.filter === 'text') return `${label(play)} ${play.title}`.toLowerCase().includes(needle);
    return true;
  });
  switch (def.metric) {
    case 'plays':
      return matching.length;
    case 'hours':
      return matching.reduce((sum, play) => sum + play.durationMs, 0) / HOUR_MS;
    case 'days':
      return new Set(matching.map((play) => play.day)).size;
    case 'titles':
      return new Set(matching.map((play) => play.itemId)).size;
    case 'shows':
      return new Set(matching.flatMap((play) => (play.mediaType === 'episode' && play.show ? [play.show] : []))).size;
  }
}

/** The admin-defined badges for one set of plays, in definition order. */
export function computeCustomAchievements(plays: PlayRow[], defs: CustomBadgeDef[]): Achievement[] {
  return defs.map((def) => ({
    ...tierState(`c${def.id}`, customValue(def, plays), def.tiers),
    custom: { name: def.name, description: def.description, icon: def.icon },
  }));
}

// ---------------------------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------------------------

export const XP_PER_TIER = 10;
export const MAX_LEVEL = 10;

/** XP at which a level starts: 0, 20, 60, 120, 200 ... 900 for level 10. */
export const levelStart = (level: number): number => 10 * level * (level - 1);

export interface Level {
  level: number;
  xp: number;
  /** XP at the start of this level, and at the start of the next (null on the last one). */
  from: number;
  to: number | null;
  progress: number;
}

/** Every tier reached on any badge is worth the same, so a rare badge and a common one weigh alike. */
export function levelOf(achievements: Achievement[]): Level {
  const xp = achievements.reduce((sum, a) => sum + a.tier, 0) * XP_PER_TIER;
  let level = 1;
  while (level < MAX_LEVEL && xp >= levelStart(level + 1)) level += 1;
  const from = levelStart(level);
  const to = level < MAX_LEVEL ? levelStart(level + 1) : null;
  return { level, xp, from, to, progress: to === null ? 1 : (xp - from) / (to - from) };
}
