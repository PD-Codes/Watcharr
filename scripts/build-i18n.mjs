import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Merges src/i18n/parts/*.json into one dictionary per locale. The parts carry both
// languages per key so a translation is written next to its original; the app wants one
// flat file per locale, so this is the step in between.

const partsDir = join(process.cwd(), 'src/i18n/parts');
const en = {};
const de = {};
const seen = new Map();

for (const file of readdirSync(partsDir).filter((f) => f.endsWith('.json')).sort()) {
  const part = JSON.parse(readFileSync(join(partsDir, file), 'utf8'));
  for (const [key, value] of Object.entries(part)) {
    // A key defined twice would silently take whichever file sorted last, and the two
    // wordings would drift apart unnoticed.
    if (seen.has(key)) {
      throw new Error(`Duplicate key "${key}" in ${file}, already defined in ${seen.get(key)}`);
    }
    seen.set(key, file);
    if (typeof value?.en !== 'string') throw new Error(`Missing English for "${key}" in ${file}`);
    en[key] = value.en;
    // A missing translation falls back per key at runtime, so it is left out rather than
    // filled with the English text — that way it is still findable later.
    if (typeof value.de === 'string' && value.de) de[key] = value.de;
  }
}

const sorted = (object) =>
  Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));

writeFileSync('src/i18n/en-US.json', `${JSON.stringify(sorted(en), null, 2)}\n`);
writeFileSync('src/i18n/de-DE.json', `${JSON.stringify(sorted(de), null, 2)}\n`);

const missing = Object.keys(en).filter((key) => !(key in de));
console.log(`${Object.keys(en).length} keys, ${missing.length} without a German translation`);
if (missing.length) console.log(missing.slice(0, 20).join('\n'));
