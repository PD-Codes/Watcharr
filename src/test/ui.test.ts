// Pure parts of the UI rework: admin navigation groups, transcode reason labels and the
// search shortcut label.
// Run: npx tsx --require ./src/test/server-only-shim.cjs src/test/ui.test.ts
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import enUS from '../i18n/en-US.json';
import deDE from '../i18n/de-DE.json';
import { translator, type TranslationKey } from '../i18n';
import {
  activeGroup,
  adminGroups,
  adminNav,
  modifierLabel,
  openGroups,
  parseRemembered,
  userNav,
} from '../app/(app)/nav';
import {
  humanizeReason,
  reasonLabel,
  splitReasons,
  tallyReasons,
} from '../server/transcodereasons';

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

const t = translator('en-US');
const hrefs = (items: { href: string }[]) => items.map((item) => item.href);

// --- admin navigation groups -------------------------------------------------------------

test('a global admin gets every admin destination exactly once, in groups', () => {
  const all = hrefs(adminNav(t, true, true));
  assert.equal(all.length, 18);
  assert.equal(new Set(all).size, all.length, 'no destination in two groups');
  for (const href of ['/admin/activity', '/admin/doctor', '/admin/config', '/admin/import', '/admin/stats']) {
    assert.ok(all.includes(href), href);
  }
});

test('visibility rules survive the grouping', () => {
  const server = hrefs(adminNav(t, true, false));
  for (const href of ['/admin/servers', '/admin/notifications', '/admin/newsletter', '/admin/badges',
    '/admin/import', '/admin/backups', '/admin/caches', '/admin/doctor', '/admin/config']) {
    assert.ok(!server.includes(href), `${href} is for global admins only`);
  }
  assert.ok(server.includes('/admin/system'), 'system status stays visible to server admins');
  assert.ok(!hrefs(adminNav(t, false, true)).includes('/admin/stats'), 'feature flag hides server stats');
});

test('groups that end up empty are dropped', () => {
  const keys = adminGroups(t, true, false).map((group) => group.key);
  assert.deepEqual(keys, ['live', 'access', 'analysis', 'system']);
});

test('no group is taller than four rows (the sidebar has to fit 1000px)', () => {
  for (const group of adminGroups(t, true, true)) {
    assert.ok(group.items.length <= 4, `${group.key} has ${group.items.length}`);
  }
  assert.ok(userNav(t, true).length <= 13);
});

test('the group of the current page is found, nested routes included', () => {
  const groups = adminGroups(t, true, true);
  assert.equal(activeGroup(groups, '/admin/activity'), 'live');
  assert.equal(activeGroup(groups, '/admin/users/42'), 'access');
  assert.equal(activeGroup(groups, '/admin/doctor'), 'system');
  assert.equal(activeGroup(groups, '/admin/config'), 'setup');
  assert.equal(activeGroup(groups, '/history'), null);
});

test('only the current group is open without a remembered choice', () => {
  const keys = ['live', 'access', 'system'];
  assert.deepEqual(openGroups(keys, 'access', {}), { live: false, access: true, system: false });
  assert.deepEqual(openGroups(keys, null, {}), { live: false, access: false, system: false });
});

test('remembered choices apply, the current group opens on arrival but can be closed', () => {
  const keys = ['live', 'access', 'system'];
  const remembered = { live: true, access: false };
  assert.deepEqual(openGroups(keys, 'access', remembered), { live: true, access: true, system: false });
  assert.deepEqual(openGroups(keys, 'access', remembered, true), { live: true, access: false, system: false });
});

test('a broken remembered value means nothing remembered', () => {
  assert.deepEqual(parseRemembered(null), {});
  assert.deepEqual(parseRemembered('not json'), {});
  assert.deepEqual(parseRemembered('[true]'), {});
  assert.deepEqual(parseRemembered('{"live":true,"x":"yes"}'), { live: true });
});

// --- transcode reasons -------------------------------------------------------------------

test('joined reasons are split, blanks dropped', () => {
  assert.deepEqual(splitReasons('ContainerNotSupported, AudioCodecNotSupported'), [
    'ContainerNotSupported',
    'AudioCodecNotSupported',
  ]);
  assert.deepEqual(splitReasons('A;B|C,,'), ['A', 'B', 'C']);
  assert.deepEqual(splitReasons(''), []);
  assert.deepEqual(splitReasons(null), []);
});

test('reasons are counted after splitting, not per combination', () => {
  const tally = tallyReasons([
    { label: 'VideoCodecNotSupported', value: 5 },
    { label: 'VideoCodecNotSupported,AudioCodecNotSupported', value: 3 },
    { label: 'AudioCodecNotSupported', value: 1 },
    { label: 'ContainerNotSupported, ContainerNotSupported', value: 2 },
  ]);
  assert.deepEqual(tally, [
    { label: 'VideoCodecNotSupported', value: 8 },
    { label: 'AudioCodecNotSupported', value: 4 },
    { label: 'ContainerNotSupported', value: 2 },
  ]);
  assert.equal(tallyReasons([{ label: 'A', value: 1 }, { label: 'B', value: 1 }], 1).length, 1);
});

test('unknown reasons read as words', () => {
  assert.equal(humanizeReason('VideoCodecNotSupported'), 'Video codec not supported');
  assert.equal(humanizeReason('HDRNotSupported'), 'HDR not supported');
  assert.equal(humanizeReason('audio_codec'), 'Audio codec');
  assert.equal(humanizeReason('SomeNewReason2'), 'Some new reason2');
});

test('known reasons use the translation, unknown ones fall back', () => {
  const en = (key: string) => t(key as TranslationKey);
  const de = (key: string) => translator('de-DE')(key as TranslationKey);
  assert.equal(reasonLabel('ContainerBitrateExceedsLimit', en), 'Bitrate above the client limit');
  assert.equal(reasonLabel('VideoCodecNotSupported', de), 'Videocodec nicht unterstützt');
  assert.equal(reasonLabel('BrandNewThing', en), 'Brand new thing');
  assert.equal(reasonLabel('weird token!', en), 'Weird token!');
});

test('every Plex-derived token has a label', () => {
  for (const token of ['VideoCodecNotSupported', 'VideoResolutionNotSupported', 'ContainerBitrateExceedsLimit',
    'AudioCodecNotSupported', 'SubtitleCodecNotSupported', 'ContainerNotSupported']) {
    assert.ok(`ui2.reason.${token}` in enUS, token);
    assert.ok(`ui2.reason.${token}` in deDE, token);
  }
});

// --- search shortcut label ---------------------------------------------------------------

test('the search shortcut names the key the keyboard has', () => {
  assert.equal(modifierLabel('MacIntel'), '⌘K');
  assert.equal(modifierLabel('iPhone'), '⌘K');
  assert.equal(modifierLabel('Win32'), 'Ctrl K');
  assert.equal(modifierLabel('Linux x86_64'), 'Ctrl K');
  assert.equal(modifierLabel(''), 'Ctrl K');
});

// --- i18n --------------------------------------------------------------------------------

test('every ui2 key has both languages', () => {
  const part = JSON.parse(readFileSync(join(process.cwd(), 'src/i18n/parts/ui2.json'), 'utf8')) as Record<
    string,
    { en?: string; de?: string }
  >;
  for (const [key, value] of Object.entries(part)) {
    assert.ok(key.startsWith('ui2.'), key);
    assert.ok(value.en && value.de, key);
  }
});

// --- global stylesheet ------------------------------------------------------------------

test('globals.css imports every style part once, in file-name order, and nothing else', () => {
  const index = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
  const imported = [...index.matchAll(/@import '\.\/styles\/([^']+)'/g)].map((match) => match[1]);
  const files = readdirSync(join(process.cwd(), 'src/app/styles')).filter((name) => name.endsWith('.css')).sort();
  assert.deepEqual(imported, files, 'the numbered order is the cascade order');
  const rules = index.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import [^;]+;/g, '').trim();
  assert.equal(rules, '', 'the index holds imports only; a rule belongs in the part of its area');
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall ui tests passed');
