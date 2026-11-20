import Link from 'next/link';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { appConfig, users } from '@/db/schema';
import { formatDate, formatDuration, intParam } from '@/components/format';
import Pager, { PAGE_SIZE } from '@/components/Pager';
import { readDb } from '@/server/readcache';
import { requireAdmin } from '@/server/session';
import { scopeFilter } from '@/server/stats';
import { getLocale, getT } from '@/i18n/server';
import SyncUsersButton from './SyncUsersButton';
import RoleToggle from './RoleToggle';
import DeleteUserButton from './DeleteUserButton';
import ViewAsButton from '../../ViewAsButton';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const session = await requireAdmin();
  const t = await getT();
  const locale = await getLocale();
  const global = session.user.globalAdmin;

  // A server admin administers their own server, so other servers' accounts are none of
  // their business — not even by name.
  const visibleTo = global ? sql`1 = 1` : eq(users.serverId, session.user.serverId);
  // The accounts themselves are live from the main connection (a role change or a deletion must
  // show on the next render); a deployment has hundreds of them at most.
  const accounts = await db
    .select({
      id: users.id,
      username: users.username,
      isAdmin: users.isAdmin,
      globalAdmin: users.globalAdmin,
      serverLabel: appConfig.label,
      lastSeenAt: users.lastSeenAt,
    })
    .from(users)
    .leftJoin(appConfig, eq(appConfig.id, users.serverId))
    .where(visibleTo);
  // The play counts are an aggregate over the whole history, and the page sorts by them, so it
  // cannot be narrowed to the 20 rows shown. It used to run as a join on the main connection on
  // every page change; through readDb it runs on a reader thread and a slow answer is reused for
  // 30 s while someone pages through the list. Per user_id only, so the covering
  // (user_id, watched_at, duration_ms, …) index answers it without touching the table.
  const scope = global ? { userId: null } : { userId: null, serverId: session.user.serverId };
  const totals = new Map(
    (
      await readDb.all<{ user_id: number; plays: number; watchtime: number }>(sql`
        SELECT user_id, count(*) AS plays, coalesce(sum(duration_ms), 0) AS watchtime
        FROM watch_history
        WHERE ${scopeFilter(scope)}
        GROUP BY user_id
      `)
    ).map((r) => [Number(r.user_id), { plays: Number(r.plays), watchtime: Number(r.watchtime) }]),
  );
  const ranked = accounts
    .map((account) => ({ ...account, ...(totals.get(account.id) ?? { plays: 0, watchtime: 0 }) }))
    // The name and id break ties, otherwise equal play counts could swap places between pages.
    .sort((a, b) => b.plays - a.plays || (a.username < b.username ? -1 : a.username > b.username ? 1 : 0) || a.id - b.id);

  const pages = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE));
  const page = Math.min(intParam((await searchParams).page, 1), pages);
  const rows = ranked.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminUsers')}</h1>
      <p className="subtitle">
        {global ? t('users.subtitleGlobal') : t('users.subtitleServer')}
      </p>
      <SyncUsersButton />

      {global && (
        <details className="card section">
          <summary>{t('users.globalInfoTitle')}</summary>
          <p>{t('users.globalInfoIntro')}</p>
          <ul>
            <li>{t('users.globalInfo1')}</li>
            <li>{t('users.globalInfo2')}</li>
            <li>{t('users.globalInfo3')}</li>
            <li>{t('users.globalInfo4')}</li>
          </ul>
          <p className="muted">{t('users.globalInfoNote')}</p>
        </details>
      )}

      <div className="table-wrap card section">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('common.user')}</th>
              {global && <th scope="col" className="secondary-col">{t('users.colServer')}</th>}
              <th scope="col">{t('users.colRole')}</th>
              <th scope="col" className="secondary-col">{t('users.colPlays')}</th>
              <th scope="col">{t('common.watchTime')}</th>
              <th scope="col">{t('users.colLastSeen')}</th>
              <th scope="col">{t('viewAs.column')}</th>
              <th scope="col">{t('users.colDelete')}</th>
              {global && <th scope="col">{t('users.colGlobalAdmin')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/admin/users/${row.id}`}>{row.username}</Link>
                </td>
                {global && <td className="secondary-col">{row.serverLabel ?? '—'}</td>}
                <td>
                  {row.globalAdmin
                    ? t('users.roleGlobalAdmin')
                    : row.isAdmin
                      ? t('users.roleServerAdmin')
                      : t('users.roleUser')}
                </td>
                <td className="secondary-col">{row.plays}</td>
                <td>{formatDuration(Number(row.watchtime))}</td>
                <td className="when-cell">
                  {row.lastSeenAt ? formatDate(row.lastSeenAt, locale) : t('common.never')}
                </td>
                <td>{row.id !== session.user.id && <ViewAsButton userId={row.id} />}</td>
                <td>
                  {/* A global admin has to lose the role first; yourself you cannot delete. */}
                  {row.id !== session.user.id && !row.globalAdmin && (
                    <DeleteUserButton userId={row.id} username={row.username} plays={Number(row.plays)} />
                  )}
                </td>
                {global && (
                  <td>
                    <RoleToggle
                      userId={row.id}
                      username={row.username}
                      globalAdmin={row.globalAdmin}
                      self={row.id === session.user.id}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} />
    </>
  );
}
