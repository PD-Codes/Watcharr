'use client';

import { useState } from 'react';
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

  async function search(event: React.FormEvent) {
    event.preventDefault();
    const res = await fetch(`/api/library/search?q=${encodeURIComponent(query)}`);
    setHits(res.ok ? ((await res.json()) as { items: SearchHit[] }).items : []);
  }

  async function add(hit: SearchHit) {
    await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hit),
    });
    setHits([]);
    setQuery('');
    router.refresh();
  }

  async function setStatus(itemId: string, status: string) {
    await fetch('/api/watchlist', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, status }),
    });
    router.refresh();
  }

  async function remove(itemId: string) {
    await fetch(`/api/watchlist?itemId=${encodeURIComponent(itemId)}`, { method: 'DELETE' });
    router.refresh();
  }

  return (
    <>
      <form className="filters" onSubmit={search}>
        <label>
          {t('watchlist.addFromLibrary')}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('watchlist.searchPlaceholder')}
          />
        </label>
        <button>{t('action.search')}</button>
      </form>

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
        <p className="muted">{t('watchlist.empty')}</p>
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
