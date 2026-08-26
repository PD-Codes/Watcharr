import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listServers } from '@/server/config';
import { getSession } from '@/server/session';
import { getT } from '@/i18n/server';
import LoginForm from './LoginForm';
import PlexLogin from './PlexLogin';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ server?: string }>;
}) {
  const servers = await listServers();
  if (!servers.length) redirect('/setup');
  if (await getSession()) redirect('/watchlist');

  const t = await getT();
  const slug = (await searchParams).server;
  // A single-server deployment never sees a picker: the one server is the only answer.
  const selected = servers.length === 1 ? servers[0] : servers.find((s) => s.slug === slug);

  if (!selected) {
    return (
      <div className="center card">
        <h1>{t('app.name')}</h1>
        <p className="subtitle">{t('login.chooseServer')}</p>
        <div className="server-picker">
          {servers.map((server) => (
            <Link key={server.id} href={`/login?server=${server.slug}`} className="server-choice">
              <strong>{server.label}</strong>
              <span className="muted">{server.serverType}</span>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="center card">
      <h1>{selected.label}</h1>
      {servers.length > 1 && (
        <p className="subtitle">
          <Link href="/login">{t('login.differentServer')}</Link>
        </p>
      )}
      {selected.serverType === 'plex' ? (
        <PlexLogin serverId={selected.id} />
      ) : (
        <LoginForm serverId={selected.id} />
      )}
    </div>
  );
}
