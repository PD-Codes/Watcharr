import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { searchLibrary } from '@/server/library';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export interface SearchResult {
  kind: 'title' | 'library' | 'user';
  label: string;
  sub?: string;
  href: string;
}

const PER_KIND = 8;

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const q = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (q.length < 2) return NextResponse.json({ results: [] });

  const needle = `%${q}%`;
  const results: SearchResult[] = [];

  // SQLite's LIKE is already case-insensitive for ASCII, so no ILIKE is needed.
  const titles = await db.all<{ label: string; plays: number }>(sql`
    SELECT coalesce(grandparent_title, title) AS label, count(*) AS plays
    FROM watch_history
    WHERE user_id = ${session.user.id}
      AND (title LIKE ${needle} OR grandparent_title LIKE ${needle})
    GROUP BY label
    ORDER BY max(watched_at) DESC
    LIMIT ${PER_KIND}
  `);
  for (const t of titles) {
    results.push({
      kind: 'title',
      label: t.label,
      sub: `${Number(t.plays)} plays`,
      href: `/title/${encodeURIComponent(t.label)}`,
    });
  }

  // The media server may be down; the palette stays useful without library hits.
  const library = await searchLibrary(session.user.serverId, q, PER_KIND).catch(() => []);
  for (const item of library) {
    results.push({
      kind: 'library',
      label: item.title,
      sub: item.year ? String(item.year) : undefined,
      href: `/title/${encodeURIComponent(item.title)}`,
    });
  }

  if (session.user.isAdmin || session.user.globalAdmin) {
    // A server admin must not find accounts that live on another server.
    const visible = session.user.globalAdmin
      ? sql`1 = 1`
      : sql`server_id = ${session.user.serverId}`;
    const found = await db.all<{ id: number; username: string }>(sql`
      SELECT id, username FROM users
      WHERE username LIKE ${needle} AND ${visible}
      ORDER BY username
      LIMIT ${PER_KIND}
    `);
    for (const u of found) {
      results.push({ kind: 'user', label: u.username, href: `/admin/users/${u.id}` });
    }
  }

  return NextResponse.json({ results });
}
