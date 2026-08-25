import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// compareVersions is pure, but importing it pulls in server/update.ts, which reaches
// config.ts and therefore opens the database. Without a path of its own this suite opened
// the *real* ./data/watcharr.db of whoever ran it — every other suite makes its own file
// for exactly this reason. Set before the import, since the connection opens on load.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'watcharr-update-test-')), 'test.db');
process.env.SESSION_SECRET ??= 'test-secret';

async function main() {
  const { compareVersions } = await import('../server/update');

  const older = (a: string, b: string) => {
    assert.ok(compareVersions(a, b) < 0, `${a} should be older than ${b}`);
    assert.ok(compareVersions(b, a) > 0, `${b} should be newer than ${a}`);
  };

  older('1.0.0', '1.0.1');
  older('1.0.9', '1.1.0');
  older('1.9.0', '2.0.0');
  // String comparison would put 10 before 9 here, which is the whole point of parsing.
  older('1.9.0', '1.10.0');
  older('0.9.0', '1.0.0');
  console.log('ok - ordering is numeric, not lexical');

  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0, 'leading v is ignored');
  assert.equal(compareVersions('V1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions(' 1.2.3 ', '1.2.3'), 0, 'surrounding whitespace is ignored');
  assert.equal(compareVersions('1.2', '1.2.0'), 0, 'missing segments count as zero');
  console.log('ok - equal versions compare equal');

  // Pre-release suffixes are cut off, so an rc never reads as newer than the release.
  assert.equal(compareVersions('1.2.0-rc1', '1.2.0'), 0);
  older('1.2.0-rc1', '1.3.0');
  console.log('ok - pre-release suffixes are ignored');

  // A malformed tag must not report an update; unparsable segments become zero.
  assert.ok(compareVersions('nightly', '1.0.0') < 0);
  assert.equal(compareVersions('', '0.0.0'), 0);
  console.log('ok - malformed tags do not claim an update');
}

void main();
