import Link from 'next/link';
import { viewQuery, type View } from '@/server/viewscope';
import { getT } from '@/i18n/server';

/**
 * "Me" / "Server" as links, plus one link per server for a global admin with several.
 * Renders nothing for someone who only has the personal view.
 */
export default async function ViewSwitch({
  view,
  base,
  extra = {},
  className = 'seg',
}: {
  view: View;
  base: string;
  /** Parameters to keep across the switch (the year, say). */
  extra?: Record<string, string | number>;
  className?: string;
}) {
  if (!view.canServer) return null;
  const t = await getT();
  const multi = view.servers.length > 1;
  return (
    <nav className={className} aria-label={t('view.label')}>
      <Link href={`${base}${viewQuery({ kind: 'me' }, extra)}`} className={view.kind === 'me' ? 'on' : undefined}>
        {t('view.me')}
      </Link>
      {multi ? (
        view.servers.map((server) => {
          const on = view.kind === 'server' && view.server.id === server.id;
          return (
            <Link
              key={server.id}
              href={`${base}${viewQuery({ kind: 'server', server: server.slug }, extra)}`}
              className={on ? 'on' : undefined}
              aria-current={on ? 'page' : undefined}
            >
              {server.label}
            </Link>
          );
        })
      ) : (
        <Link
          href={`${base}${viewQuery({ kind: 'server' }, extra)}`}
          className={view.kind === 'server' ? 'on' : undefined}
        >
          {t('view.server')}
        </Link>
      )}
    </nav>
  );
}
