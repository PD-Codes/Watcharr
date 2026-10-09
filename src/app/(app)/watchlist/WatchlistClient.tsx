'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

export interface WatchlistItem {
  itemId: string;
  title: string;
  mediaType: string;
  year: number | null;
  status: string;
  source: string;
}

interface SearchHit {
  itemId: string;
  title: string;
  mediaType: string;
  year?: number;
}

export default function WatchlistClient({ items }: { items: WatchlistItem[] }) {
  const router = useRouter();
  const t = useT();
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [query, setQuery] = useState('');
  // The query the current `hits` answer, so "nothing found" can name it and stays quiet
  // before the first search.
  const [searched, setSearched] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchField = useRef<HTMLInputElement>(null);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const res = await fetch(`/api/library/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error(String(res.status));
      setHits(((await res.json()) as { items: SearchHit[] }).items);
      setSearched(query);
    } catch {
      setHits([]);
      setSearched(null);
      setError(t('watchlist.searchFailed'));
    }
  }

  /**
   * Every write goes through here. A refused or unreachable request used to refresh the
   * page as if it had worked, so the row snapped back with no word on why.
   */
  async function write(request: () => Promise<Response>): Promise<boolean> {
    setError(null);
    try {
      const res = await request();
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
      return true;
    } catch {
      setError(t('watchlist.actionFailed'));
      return false;
    }
  }

  async function add(hit: SearchHit) {
    const ok = await write(() =>
      fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hit),
      }),
    );
    // On failure the results stay, so the same click can simply be repeated.
    if (!ok) return;
    setHits([]);
    setSearched(null);
    setQuery('');
  }

  function setStatus(itemId: string, status: string) {
    return write(() =>
      fetch('/api/watchlist', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, status }),
      }),
    );
  }

  function remove(itemId: string) {
    return write(() =>
      fetch(`/api/watchlist?itemId=${encodeURIComponent(itemId)}`, { method: 'DELETE' }),
    );
  }

  return (
    <>
      <form className="filters" onSubmit={search}>
        <label>
          {t('watchlist.addFromLibrary')}
          <input
            ref={searchField}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('watchlist.searchPlaceholder')}
          />
        </label>
        <button>{t('action.search')}</button>
      </form>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {searched !== null && hits.length === 0 && (
        <p className="muted" role="status">
          {t('watchlist.noResults', { query: searched })}
        </p>
      )}

      {hits.length > 0 && (
        <div className="card section" style={{ marginTop: 0 }}>
          {hits.map((hit) => (
            <div className="row" key={hit.itemId} style={{ justifyContent: 'space-between' }}>
              <span>
                {hit.title} <span className="muted">{hit.year ?? ''}</span>
              </span>
              <button onClick={() => add(hit)}>{t('watchlist.add')}</button>
            </div>
          ))}
        </div>
      )}

      {items.length === 0 ? (
        <div className="card empty">
          <p>{t('watchlist.empty')}</p>
          <button type="button" className="tonal" onClick={() => searchField.current?.focus()}>
            {t('watchlist.emptyAction')}
          </button>
        </div>
      ) : (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('common.title')}</th>
                <th scope="col">{t('common.type')}</th>
                <th scope="col">{t('common.year')}</th>
                <th scope="col">{t('watchlist.status')}</th>
                <th scope="col">{t('watchlist.source')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.itemId}>
                  <td>{item.title}</td>
                  <td>{item.mediaType}</td>
                  <td>{item.year ?? '—'}</td>
                  <td>
                    <select
                      value={item.status}
                      onChange={(event) => setStatus(item.itemId, event.target.value)}
                    >
                      <option value="planned">{t('watchlist.planned')}</option>
                      <option value="watching">{t('watchlist.watching')}</option>
                      <option value="done">{t('watchlist.done')}</option>
                    </select>
                  </td>
                  <td>
                    <span className="badge">{item.source}</span>
                  </td>
                  <td>
                    <button className="link" onClick={() => remove(item.itemId)}>
                      {t('watchlist.remove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
