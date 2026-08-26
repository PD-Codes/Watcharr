'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/Icons';
import { isActive, type NavItem } from './nav';
import { useT } from '@/i18n/client';

/** Material navigation bar: the five destinations a phone gets one tap away. */
export default function BottomNav({ items, liveCount }: { items: NavItem[]; liveCount: number }) {
  const pathname = usePathname();
  const t = useT();

  return (
    <nav className="bottomnav" aria-label={t('shell.primaryNav')}>
      <ul>
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={active ? 'active' : undefined}
                aria-current={active ? 'page' : undefined}
              >
                <span className="ind">
                  <Icon name={item.icon} />
                </span>
                <span>
                  {item.label}
                  {item.href === '/activity' && liveCount > 0 && <span className="bulb on" />}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
