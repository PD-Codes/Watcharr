import { redirect } from 'next/navigation';
import { and, like, sql } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions } from '@/db/schema';
import { getSettings, isConfigured } from '@/server/config';
import { isEnabled } from '@/server/features';
import { liveSessionFilter, syncActivity, runInBackground } from '@/server/sync';
import { getSession, isAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import NavLink from './NavLink';
import SignOutButton from './SignOutButton';
import AppBar from './AppBar';
import BottomNav from './BottomNav';
import { adminNav, bottomNav, userNav } from './nav';
import Tooltip from '@/components/Tooltip';
import CommandPalette from '@/components/CommandPalette';
import Shortcuts from '@/components/Shortcuts';
import RailToggle from './RailToggle';
import ViewAsButton from './ViewAsButton';
import DataProgress from './DataProgress';
import TopBar from './TopBar';
import './shell.css';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!(await isConfigured())) redirect('/setup');
  const session = await getSession();
  if (!session) redirect('/login');

  const t = await getT();
  const settings = await getSettings();
  const suggestionsEnabled = isEnabled(settings.features, 'suggestions');
  const serverStatsEnabled = isEnabled(settings.features, 'serverWideStats');

  // Polling here rather than per page keeps the bulb honest on every route.
  runInBackground(syncActivity(), 'activity sync');

  // Drives the bulb in the wordmark: lit while anything is playing on the server. A paused
  // stream is still "live" for the counts, but it is not playing, so it does not light amber.
  const [live] = await db
    .select({
      count: sql<number>`count(*)`,
      playing: sql<number>`coalesce(sum(CASE WHEN ${playbackSessions.state} <> 'paused' THEN 1 ELSE 0 END), 0)`,
      // "Activity" is the personal page: its dot is about this person, not about the server.
      mine: sql<number>`coalesce(sum(CASE WHEN ${playbackSessions.state} <> 'paused' AND ${playbackSessions.userId} = ${session.user.id} THEN 1 ELSE 0 END), 0)`,
    })
    .from(playbackSessions)
    .where(
      session.user.globalAdmin
        ? liveSessionFilter()
        : // Session keys carry the server id; another server's streams are none of this user's business.
          and(liveSessionFilter(), like(playbackSessions.sessionKey, `${session.user.serverId}:%`)),
    );
  const liveCount = Number(live?.count ?? 0);
  const playingCount = Number(live?.playing ?? 0);
  const minePlaying = Number(live?.mine ?? 0);

  const nav = userNav(t, suggestionsEnabled);
  const adminItems = isAdmin(session.user)
    ? adminNav(t, serverStatsEnabled, session.user.globalAdmin)
    : [];

  return (
    <div className="shell" data-live={playingCount > 0 ? '1' : undefined}>
      {/* First in tab order, before the sidebar: that is the whole point of a skip link. */}
      <a className="skip-link" href="#main">
        {t('shell.skip')}
      </a>
      {/* Permanent navigation drawer. Hidden below 880px, where AppBar takes over. */}
      <aside className="sidebar">
        <div className="wordmark">
          <span
            className={`bulb ${playingCount > 0 ? 'on' : ''}`}
            data-tip={playingCount > 0 ? t('shell.playing', { count: playingCount }) : t('shell.idle')}
          />
          <span>{t('app.name')}</span>
        </div>

        <nav>
          {nav.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              icon={item.icon}
              trailing={item.href === '/activity' && minePlaying > 0 ? <span className="bulb on" /> : null}
            >
              {item.label}
            </NavLink>
          ))}

          {adminItems.length > 0 && (
            <>
              <p className="group">{t('nav.admin')}</p>
              {adminItems.map((item) => (
                <NavLink
                  key={item.href}
                  href={item.href}
                  icon={item.icon}
                  trailing={
                    item.href === '/admin/activity' && liveCount > 0 ? (
                      <span className="badge live">{liveCount}</span>
                    ) : null
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </>
          )}

        </nav>

        {/* Sticky at the bottom: with the admin group the nav is taller than most screens,
            and sign-out plus the rail switch must not sit below the fold. */}
        <div className="sidebar-foot">
          <nav aria-label={session.user.username}>
            <SignOutButton />
          </nav>
          <RailToggle />
        </div>
      </aside>

      <div className="content">
        <TopBar
          username={session.user.username}
          liveCount={liveCount}
          playingCount={playingCount}
          liveHref={isAdmin(session.user) ? '/admin/activity' : '/activity'}
        />
        <AppBar
          username={session.user.username}
          liveCount={liveCount}
          playingCount={playingCount}
          minePlaying={minePlaying}
          nav={nav}
          adminItems={adminItems}
        />
        <main className="main" id="main" tabIndex={-1}>
          <DataProgress />
          {children}
        </main>
      </div>

      <BottomNav items={bottomNav(t, suggestionsEnabled)} playingCount={minePlaying} />
      <CommandPalette userKey={session.user.id} pages={[...nav, ...adminItems]} />
      <Shortcuts />
      <Tooltip />
      {session.preview && (
        // Fixed pill rather than a bar in the grid: it must never move the page it is previewing.
        <div className="preview-pill" role="status">
          <span>{t('viewAs.banner', { user: session.user.username, admin: session.preview.admin.username })}</span>
          <ViewAsButton />
        </div>
      )}
    </div>
  );
}
