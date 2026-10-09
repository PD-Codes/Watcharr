import Link from 'next/link';
import ThemeToggle from '@/components/ThemeToggle';
import { SearchTrigger } from '@/components/CommandPalette';
import { getT } from '@/i18n/server';

/**
 * Desktop top bar: search, the live indicator, theme and who is signed in. Hidden below
 * 880px, where the app bar does the same job. Amber appears here only as the bulb, which
 * is lit exactly while something is playing.
 */
export default async function TopBar({
  username,
  liveCount,
  playingCount,
  liveHref,
}: {
  username: string;
  liveCount: number;
  playingCount: number;
  liveHref: string;
}) {
  const t = await getT();

  return (
    <header className="topbar">
      <SearchTrigger />
      <span className="topbar-spacer" />

      <Link className={`live-pill ${playingCount > 0 ? 'on' : ''}`} href={liveHref}>
        <span className={`bulb ${playingCount > 0 ? 'on' : ''}`} />
        {playingCount > 0
          ? t('shell.playing', { count: playingCount })
          : liveCount > 0
            ? t('shell.paused', { count: liveCount })
            : t('shell.idle')}
      </Link>

      <ThemeToggle />
      <Link className="avatar" href="/profile" aria-label={username} data-tip={username}>
        {username.slice(0, 1).toUpperCase()}
      </Link>
    </header>
  );
}
