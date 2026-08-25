import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions } from '@/db/schema';
import { getSettings, isConfigured } from '@/server/config';
import { isEnabled } from '@/server/features';
import { liveSessionFilter, reportSyncError, syncActivity } from '@/server/sync';
import { getSession, isAdmin } from '@/server/session';
import { t } from '@/i18n';
import NavLink from './NavLink';
import SignOutButton from './SignOutButton';
import AppBar from './AppBar';
import BottomNav from './BottomNav';
import { adminNav, bottomNav, userNav } from './nav';
import Tooltip from '@/components/Tooltip';
import ThemeToggle from '@/components/ThemeToggle';
import CommandPalette, { SearchTrigger } from '@/components/CommandPalette';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!(await isConfigured())) redirect('/setup');
  const session = await getSession();
  if (!session) redirect('/login');

  const settings = await getSettings();
  const suggestionsEnabled = isEnabled(settings.features, 'suggestions');
  const serverStatsEnabled = isEnabled(settings.features, 'serverWideStats');

  // Polling here rather than per page keeps the bulb honest on every route.
  await syncActivity().catch(reportSyncError('activity sync'));

  // Drives the bulb in the wordmark: lit while anything is playing on the server.
  const [live] = await db
    .select({ count: sql<number>`count(*)` })
    .from(playbackSessions)
    .where(liveSessionFilter());
  const liveCount = Number(live?.count ?? 0);

  const nav = userNav(suggestionsEnabled);
  const adminItems = isAdmin(session.user)
    ? adminNav(serverStatsEnabled, session.user.globalAdmin)
    : [];

  return (
    <div className="shell">
      {/* Permanent navigation drawer. Hidden below 880px, where AppBar takes over. */}
      <aside className="sidebar">
        <div className="wordmark">
          <span
            className={`bulb ${liveCount > 0 ? 'on' : ''}`}
            data-tip={liveCount > 0 ? `${liveCount} playing` : 'Idle'}
          />
          <span>{t('app.name')}</span>
        </div>

        <SearchTrigger />

        <nav>
          {nav.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              icon={item.icon}
              trailing={item.href === '/activity' && liveCount > 0 ? <span className="bulb on" /> : null}
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

          <p className="group">{session.user.username}</p>
          <SignOutButton />
        </nav>

        <div className="sidebar-foot">
          <ThemeToggle />
        </div>
      </aside>

      <div className="content">
        <AppBar
          username={session.user.username}
          liveCount={liveCount}
          nav={nav}
          adminItems={adminItems}
        />
        <main className="main">{children}</main>
      </div>

      <BottomNav items={bottomNav(suggestionsEnabled)} liveCount={liveCount} />
      <CommandPalette />
      <Tooltip />
    </div>
  );
}
