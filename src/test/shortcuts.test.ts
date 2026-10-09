// Pure parts of the command palette and the global shortcuts.
// Run: npx tsx src/test/shortcuts.test.ts
import assert from 'node:assert/strict';
import { fuzzyMatch, highlightRuns } from '../components/fuzzy';
import {
  buildSections,
  flatten,
  parseRecent,
  pushRecent,
  RECENT_MAX,
  type Candidate,
  type RecentEntry,
} from '../components/palette-core';
import { GO_TO, goKeysFor, isEditableTarget, stepKey, type KeyLike } from '../components/shortcuts-core';

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${(error as Error).message}`);
  }
}

const score = (q: string, text: string) => fuzzyMatch(q, text)?.score ?? -Infinity;

// --- fuzzy -------------------------------------------------------------------------------

test('fuzzy: empty query matches everything with no highlight', () => {
  assert.deepEqual(fuzzyMatch('', 'Sessions'), { score: 0, indices: [] });
  assert.deepEqual(fuzzyMatch('   ', 'Sessions'), { score: 0, indices: [] });
});

test('fuzzy: subsequence matches, non-subsequence does not', () => {
  assert.deepEqual(fuzzyMatch('sns', 'Sessions')?.indices.length, 3);
  assert.equal(fuzzyMatch('xyz', 'Sessions'), null);
  assert.equal(fuzzyMatch('sessionss', 'Sessions'), null);
  assert.equal(fuzzyMatch('a', ''), null);
});

test('fuzzy: case and diacritics are ignored', () => {
  assert.ok(fuzzyMatch('UBER', 'Übersicht'));
  assert.deepEqual(fuzzyMatch('ub', 'Übersicht')?.indices, [0, 1]);
  assert.ok(fuzzyMatch('SESS', 'sessions'));
});

test('fuzzy: a prefix beats a word start beats a mid-word hit', () => {
  const prefix = score('act', 'Activity');
  const wordStart = score('act', 'All Activity');
  const mid = score('act', 'Interactive');
  assert.ok(prefix > wordStart, `${prefix} > ${wordStart}`);
  assert.ok(wordStart > mid, `${wordStart} > ${mid}`);
});

test('fuzzy: adjacent characters beat scattered ones', () => {
  assert.ok(score('ses', 'Sessions') > score('ses', 'Server Statistics'));
});

test('fuzzy: on equal evidence the shorter text wins', () => {
  assert.ok(score('stat', 'Stats') > score('stat', 'Stats and more'));
});

test('fuzzy: spaces in the query are ignored, words may be abbreviated', () => {
  assert.deepEqual(fuzzyMatch('all act', 'All Activity')?.indices, [0, 1, 2, 4, 5, 6]);
  assert.ok(fuzzyMatch('adm usr', 'Admin Users'));
});

test('fuzzy: picks the best alignment, not the first one', () => {
  // "ac" must land on the A of "Activity" (word start), not the a in "Walk".
  const hit = fuzzyMatch('ac', 'Walk Activity');
  assert.deepEqual(hit?.indices, [5, 6]);
});

test('fuzzy: long scattered matches are rejected as noise', () => {
  assert.equal(fuzzyMatch('sev', 'Mississippi river valley'), null);
  assert.ok(fuzzyMatch('sev', 'Server Stats'));
});

test('fuzzy: highlight runs reassemble the text', () => {
  const runs = highlightRuns('Sessions', [0, 1]);
  assert.deepEqual(runs, [
    { text: 'Se', hit: true },
    { text: 'ssions', hit: false },
  ]);
  assert.equal(runs.map((r) => r.text).join(''), 'Sessions');
  assert.deepEqual(highlightRuns('Plain', undefined), [{ text: 'Plain', hit: false }]);
  assert.deepEqual(highlightRuns('Plain', []), [{ text: 'Plain', hit: false }]);
});

// --- sections ----------------------------------------------------------------------------

const cand = (id: string, label: string, extra: Partial<Candidate> = {}): Candidate => ({
  id,
  label,
  icon: 'overview',
  ...extra,
});
const pools = {
  recent: [cand('r1', 'Severance', { recent: { href: '/title/Severance', label: 'Severance', kind: 'title' } })],
  actions: [
    cand('a-theme', 'Switch theme', { keywords: 'dark light mode appearance' }),
    cand('a-cinema', 'Cinema mode'),
  ],
  pages: [cand('p-over', 'Overview'), cand('p-sess', 'Sessions'), cand('p-stats', 'Statistics')],
  results: [] as Candidate[],
};

test('sections: empty query shows Recent, Actions, Pages unfiltered, in that order', () => {
  const sections = buildSections('', pools);
  assert.deepEqual(sections.map((s) => s.group), ['recent', 'actions', 'pages']);
  assert.equal(flatten(sections).length, 1 + 2 + 3);
});

test('sections: recent is hidden once there is a query', () => {
  assert.ok(!buildSections('s', pools).some((s) => s.group === 'recent'));
});

test('sections: pages are fuzzy-filtered and sorted by score', () => {
  const both = buildSections('ss', pools).find((s) => s.group === 'pages')!;
  assert.deepEqual(both.rows.map((r) => r.label), ['Sessions', 'Statistics']);
  assert.ok(both.rows[0].hit && both.rows[0].hit.length === 2);
  const one = buildSections('st', pools).find((s) => s.group === 'pages')!;
  assert.deepEqual(one.rows.map((r) => r.label), ['Statistics']);
});

test('sections: keywords find an action but are not highlighted', () => {
  const sections = buildSections('dark', pools);
  const actions = sections.find((s) => s.group === 'actions')!;
  assert.deepEqual(actions.rows.map((r) => r.id), ['a-theme']);
  assert.equal(actions.rows[0].hit, undefined);
});

test('sections: a query with no match anywhere yields no sections', () => {
  assert.deepEqual(buildSections('qqqq', pools), []);
});

test('sections: server results keep their order and get highlighted', () => {
  const results = [cand('x1', 'Severance'), cand('x2', 'Blade Runner')];
  const sections = buildSections('sev', { ...pools, results });
  const group = sections.find((s) => s.group === 'results')!;
  assert.deepEqual(group.rows.map((r) => r.id), ['x1', 'x2']);
  assert.deepEqual(group.rows[0].hit, [0, 1, 2]);
  assert.equal(group.rows[1].hit, undefined);
});

test('sections: groups are ordered by their best row, not by a fixed order', () => {
  const results = [cand('x1', 'The Sessions of Wonder')];
  const byPage = buildSections('sessions', { ...pools, results });
  assert.equal(byPage[0].group, 'pages');
  const byTitle = buildSections('wonder', { ...pools, results });
  assert.equal(byTitle[0].group, 'results');
});

test('sections: results alone still render while no local row matches', () => {
  const sections = buildSections('zzz', { ...pools, results: [cand('x', 'Zzz Movie')] });
  assert.deepEqual(sections.map((s) => s.group), ['results']);
});

// --- recents -----------------------------------------------------------------------------

const entry = (href: string, kind: RecentEntry['kind'] = 'title'): RecentEntry => ({ href, label: href, kind });

test('recent: newest first, deduped by href, capped at five', () => {
  let list: RecentEntry[] = [];
  for (const h of ['/a', '/b', '/c', '/d', '/e', '/f']) list = pushRecent(list, entry(h));
  assert.equal(list.length, RECENT_MAX);
  assert.deepEqual(list.map((e) => e.href), ['/f', '/e', '/d', '/c', '/b']);
  list = pushRecent(list, entry('/d'));
  assert.deepEqual(list.map((e) => e.href), ['/d', '/f', '/e', '/c', '/b']);
});

test('recent: parseRecent survives garbage', () => {
  assert.deepEqual(parseRecent(null), []);
  assert.deepEqual(parseRecent(''), []);
  assert.deepEqual(parseRecent('{not json'), []);
  assert.deepEqual(parseRecent('{"a":1}'), []);
  assert.deepEqual(parseRecent('[1, null, "x", {"href": 4}]'), []);
});

test('recent: parseRecent rejects off-site and protocol-relative hrefs', () => {
  const raw = JSON.stringify([
    { href: 'https://evil.example/', label: 'x', kind: 'title' },
    { href: '//evil.example/', label: 'x', kind: 'title' },
    { href: 'javascript:alert(1)', label: 'x', kind: 'title' },
    // Browsers read a backslash as a slash, so these are `//host` in disguise.
    { href: '/\\evil.example/', label: 'x', kind: 'title' },
    { href: '/\t/evil.example/', label: 'x', kind: 'title' },
    { href: '/with space', label: 'x', kind: 'title' },
    { href: '/ok', label: 'Fine', kind: 'page' },
  ]);
  assert.deepEqual(parseRecent(raw), [{ href: '/ok', label: 'Fine', kind: 'page' }]);
});

test('recent: parseRecent drops unknown kinds, duplicates, and caps the list', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ href: `/p${i}`, label: `P${i}`, kind: 'title' }));
  const raw = JSON.stringify([{ href: '/x', label: 'X', kind: 'nope' }, many[0], many[0], ...many]);
  const parsed = parseRecent(raw);
  assert.equal(parsed.length, RECENT_MAX);
  assert.equal(new Set(parsed.map((e) => e.href)).size, RECENT_MAX);
});

// --- keys --------------------------------------------------------------------------------

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

test('keys: single-key commands', () => {
  assert.equal(stepKey(key('/'), false).command, 'search');
  assert.equal(stepKey(key('?', { shiftKey: true }), false).command, 'help');
  assert.equal(stepKey(key('t'), false).command, 'theme');
  assert.equal(stepKey(key('['), false).command, 'rail');
  assert.equal(stepKey(key('c'), false).command, 'cinema');
  assert.equal(stepKey(key('q'), false).handled, false);
});

test('keys: g arms the prefix, the second key navigates, and the prefix is spent', () => {
  const armed = stepKey(key('g'), false);
  assert.deepEqual([armed.pending, armed.handled], [true, true]);
  const go = stepKey(key('s'), true);
  assert.deepEqual(go, { go: '/sessions', pending: false, handled: true });
});

test('keys: after g, "t" goes to statistics and does not toggle the theme', () => {
  const step = stepKey(key('t'), true);
  assert.equal(step.go, '/stats');
  assert.equal(step.command, undefined);
});

test('keys: an unknown second key cancels the prefix and is then read normally', () => {
  assert.deepEqual(stepKey(key('x'), true), { pending: false, handled: false });
  assert.equal(stepKey(key('?', { shiftKey: true }), true).command, 'help');
  assert.equal(stepKey(key('g'), true).pending, true);
});

test('keys: a lone Shift press neither cancels the prefix nor fires', () => {
  const step = stepKey(key('Shift', { shiftKey: true }), true);
  assert.deepEqual(step, { pending: true, handled: false });
});

test('keys: Ctrl, Meta and Alt combos never fire (Cmd/Ctrl+K belongs to the palette)', () => {
  assert.equal(stepKey(key('k', { ctrlKey: true }), false).handled, false);
  assert.equal(stepKey(key('t', { metaKey: true }), false).handled, false);
  assert.equal(stepKey(key('t', { altKey: true }), false).handled, false);
  assert.equal(stepKey(key('s', { ctrlKey: true }), true).go, undefined);
});

test('keys: Shift+letter is not the letter shortcut, but a symbol may need Shift', () => {
  assert.equal(stepKey(key('T', { shiftKey: true }), false).handled, false);
  assert.equal(stepKey(key('/', { shiftKey: true }), false).command, 'search'); // German layout
});

test('keys: AltGr (Ctrl+Alt on Windows) types "[" on a German layout', () => {
  assert.equal(stepKey(key('[', { ctrlKey: true, altKey: true, altGraph: true }), false).command, 'rail');
  assert.equal(stepKey(key('[', { ctrlKey: true, altKey: true }), false).handled, false);
  // Option+5 types "[" on a German Mac keyboard.
  assert.equal(stepKey(key('[', { altKey: true }), false).command, 'rail');
});

test('keys: IME composition and auto-repeat are ignored', () => {
  assert.equal(stepKey(key('t', { isComposing: true }), false).handled, false);
  assert.equal(stepKey(key('t', { repeat: true }), false).handled, false);
  assert.equal(stepKey(key('s', { repeat: true }), true).pending, true);
});

test('keys: every go-to target is unique and reverse-lookup agrees', () => {
  const targets = Object.values(GO_TO);
  assert.equal(new Set(targets).size, targets.length);
  for (const [k, href] of Object.entries(GO_TO)) assert.deepEqual(goKeysFor(href), ['g', k]);
  assert.equal(goKeysFor('/admin/users'), null);
  for (const href of ['/', '/sessions', '/watchlist', '/history', '/activity', '/stats', '/libraries',
    '/suggestions', '/wrapped', '/profile', '/pick', '/screen']) {
    assert.ok(targets.includes(href), href);
  }
});

test('keys: go-to letters never collide with the single-key commands only by accident', () => {
  // "g" is reserved as the prefix itself, so it must not be a second key.
  assert.equal(GO_TO.g, undefined);
});

test('editable: typing targets are skipped, buttons and checkboxes are not', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'search' }), true);
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV', getAttribute: () => 'true' }), true);
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isEditableTarget({ tagName: 'BODY' }), false);
  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget({}), false);
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
