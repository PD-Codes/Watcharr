import Link from 'next/link';
import { getT } from '@/i18n/server';

/** Rows per page for every list that paginates with <Pager>. */
export const PAGE_SIZE = 20;

/**
 * Reads `?page=` against the row count: junk and zero become 1, and a page past the end
 * (the last row of it was just deleted, an old bookmark) becomes the last page rather than
 * an empty table with a "next" link.
 */
export function pageOf(
  raw: string | string[] | undefined,
  total: number,
  size = PAGE_SIZE,
): { page: number; pages: number; offset: number; limit: number } {
  const pages = Math.max(1, Math.ceil(total / size));
  const requested = Number.parseInt(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''), 10);
  const page = Math.min(pages, Math.max(1, Number.isFinite(requested) ? requested : 1));
  return { page, pages, offset: (page - 1) * size, limit: size };
}

/**
 * Previous / next links for a server-rendered list. `params` are the other query
 * parameters to carry along (a search term, say); `hash` lands the reader back on the
 * list instead of the top of the page.
 */
export default async function Pager({
  page,
  pages,
  params = {},
  hash,
}: {
  page: number;
  pages: number;
  params?: Record<string, string | undefined>;
  hash?: string;
}) {
  if (pages <= 1) return null;
  const t = await getT();
  const href = (target: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
    if (target > 1) query.set('page', String(target));
    return `?${query}${hash ? `#${hash}` : ''}`;
  };
  return (
    <nav className="row section" aria-label={t('common.page', { page, pages })}>
      {page > 1 && (
        <Link className="badge" href={href(page - 1)}>
          {t('action.previous')}
        </Link>
      )}
      <span className="muted">{t('common.page', { page, pages })}</span>
      {page < pages && (
        <Link className="badge" href={href(page + 1)}>
          {t('action.next')}
        </Link>
      )}
    </nav>
  );
}
