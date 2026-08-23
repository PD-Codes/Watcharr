'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
          Add from library
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search titles…"
          />
        </label>
        <button>Search</button>
      </form>

      {hits.length > 0 && (
        <div className="card section" style={{ marginTop: 0 }}>
          {hits.map((hit) => (
            <div className="row" key={hit.itemId} style={{ justifyContent: 'space-between' }}>
              <span>
                {hit.title} <span className="muted">{hit.year ?? ''}</span>
              </span>
              <button onClick={() => add(hit)}>Add</button>
            </div>
          ))}
        </div>
      )}

      {items.length === 0 ? (
        <p className="muted">Your watchlist is empty.</p>
      ) : (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Type</th>
                <th scope="col">Year</th>
                <th scope="col">Status</th>
                <th scope="col">Source</th>
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
                      <option value="planned">Planned</option>
                      <option value="watching">Watching</option>
                      <option value="done">Done</option>
                    </select>
                  </td>
                  <td>
                    <span className="badge">{item.source}</span>
                  </td>
                  <td>
                    <button className="link" onClick={() => remove(item.itemId)}>
                      Remove
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
