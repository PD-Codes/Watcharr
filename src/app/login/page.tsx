import { redirect } from 'next/navigation';
import { getConfig } from '@/server/config';
import { getSession } from '@/server/session';
import LoginForm from './LoginForm';
import PlexLogin from './PlexLogin';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const cfg = await getConfig();
  if (!cfg) redirect('/setup');
  if (await getSession()) redirect('/watchlist');

  return (
    <div className="center card">
      <h1>{cfg.serverName ?? 'Watcharr'}</h1>
      {cfg.serverType === 'plex' ? <PlexLogin /> : <LoginForm />}
    </div>
  );
}
