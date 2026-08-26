# Translation parts

Working files, one per area of the app. Each holds the keys that area introduced, with both
languages side by side:

```json
{
  "history.title": { "en": "History", "de": "Verlauf" }
}
```

`npm run i18n:build` merges every part into `src/i18n/en-US.json` and `src/i18n/de-DE.json`,
which are what the app actually imports. Never edit those two by hand — the next build
overwrites them.

Split into parts so several people (or several agents) can add strings at once without
landing on the same lines of the same file, and so a key stays next to its translation
while it is being written.
