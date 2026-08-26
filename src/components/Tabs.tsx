import Link from 'next/link';
import { getT } from '@/i18n/server';

export interface TabDef {
  key: string;
  label: string;
}

/**
 * Tabs as links, not client state. Each tab is its own URL, so it can be linked to and
 * reloaded — and because the page reads the active tab on the server, it only runs the
 * queries that tab actually needs instead of all of them on every visit.
 */
export default async function Tabs({
  tabs,
  current,
  hrefFor,
}: {
  tabs: TabDef[];
  current: string;
  hrefFor: (key: string) => string;
}) {
  const t = await getT();
  return (
    <nav className="tabs" aria-label={t('nav.sections')}>
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={hrefFor(tab.key)}
          className={tab.key === current ? 'on' : undefined}
          aria-current={tab.key === current ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/** Falls back to the first tab for an unknown or missing key. */
export function activeTab(tabs: TabDef[], value: string | undefined): string {
  return tabs.some((tab) => tab.key === value) ? (value as string) : tabs[0].key;
}
