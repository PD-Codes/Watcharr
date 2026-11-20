/**
 * For a capped, oldest-first history batch: drops the trailing rows that share the newest
 * timestamp. The caller continues with `since` = the newest watchedAt, and the servers filter
 * strictly after it, so a second play at that very instant that fell just past the cap would
 * never come back. Dropped rows simply arrive with the next call. A batch that is one single
 * instant is kept whole, since trimming it would make no progress at all.
 */
export function trimTrailingInstant<T>(rows: T[], at: (row: T) => number): T[] {
  if (!rows.length) return rows;
  const last = at(rows[rows.length - 1]);
  let end = rows.length;
  while (end > 0 && at(rows[end - 1]) === last) end -= 1;
  return end === 0 ? rows : rows.slice(0, end);
}
