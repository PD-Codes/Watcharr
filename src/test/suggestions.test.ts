import assert from 'node:assert/strict';
import { buildProfile, scoreItem } from '../server/scoring';
import { formatDuration, percent } from '../components/format';

const history = [
  { itemId: '1', title: 'Alien', mediaType: 'movie', year: 1979, genres: ['Sci-Fi', 'Horror'] },
  { itemId: '2', title: 'Aliens', mediaType: 'movie', year: 1986, genres: ['Sci-Fi', 'Action'] },
  { itemId: '3', title: 'Alien', mediaType: 'movie', year: 1979, genres: ['Sci-Fi'] },
];

function testProfile() {
  const profile = buildProfile(history);
  assert.equal(profile.genreWeights['Sci-Fi'], 3);
  assert.equal(profile.genreWeights['Horror'], 1);
  assert.equal(profile.decadeWeights['1970'], 2);
  assert.equal(profile.typeWeights.movie, 3);
  assert.equal(profile.topTitle, 'Alien'); // watched twice
  assert.deepEqual(profile.watchedItemIds, ['1', '2', '3']);
}

function testScoringPrefersSharedGenres() {
  const profile = buildProfile(history);
  const scifi = scoreItem(profile, {
    itemId: 'x',
    title: 'Blade Runner',
    mediaType: 'movie',
    year: 1982,
    genres: ['Sci-Fi'],
  });
  const romance = scoreItem(profile, {
    itemId: 'y',
    title: 'Notting Hill',
    mediaType: 'movie',
    year: 1999,
    genres: ['Romance'],
  });

  assert.ok(scifi.score > romance.score, 'shared genres must outrank unrelated ones');
  assert.match(scifi.reason, /Sci-Fi/);
  // No genre overlap and no matching decade leaves only the media type bonus.
  assert.ok(romance.score > 0);
}

function testScoringHandlesEmptyHistory() {
  const profile = buildProfile([]);
  const { score, reason } = scoreItem(profile, {
    itemId: 'x',
    title: 'Anything',
    mediaType: 'movie',
    genres: [],
  });
  assert.equal(score, 0);
  assert.equal(reason, 'Popular in your library');
}

function testFormatting() {
  assert.equal(formatDuration(90_000), '2m');
  assert.equal(formatDuration(3_600_000), '1h 0m');
  assert.equal(formatDuration(90_000_000), '1d 1h');
  assert.equal(percent(1, 4), 25);
  assert.equal(percent(1, 0), 0); // must not divide by zero
}

for (const test of [testProfile, testScoringPrefersSharedGenres, testScoringHandlesEmptyHistory, testFormatting]) {
  test();
  console.log(`ok - ${test.name}`);
}
