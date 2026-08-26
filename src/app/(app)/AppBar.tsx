'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/Icons';
import ThemeToggle from '@/components/ThemeToggle';
import { SearchTrigger } from '@/components/CommandPalette';
import NavLink from './NavLink';
import SignOutButton from './SignOutButton';
import type { NavItem } from './nav';
import { useT } from '@/i18n/client';

/**
 * Mobile chrome: a top app bar plus a modal navigation drawer. Below 880px the permanent
 * drawer is hidden by CSS, so this is the only way to reach the admin routes that do not
 * fit in the five-slot bottom bar.
 */
export default function AppBar({
  username,
  liveCount,
  nav,
  adminItems,
}: {
  username: string;
  liveCount: number;
  nav: NavItem[];
  adminItems: NavItem[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panel = useRef<HTMLDivElement>(null);

  // Arriving somewhere new is the end of navigating.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    // Without this the page behind the drawer scrolls under the finger on iOS.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    panel.current?.focus();

    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <header className="appbar">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setOpen(true)}
          aria-label={t('shell.openNav')}
          aria-expanded={open}
        >
          <Icon name="menu" />
        </button>

        <p className="appbar-title">
          <span className={`bulb ${liveCount > 0 ? 'on' : ''}`} />
          <span>{t('app.name')}</span>
        </p>

        <div className="appbar-actions">
          <SearchTrigger compact />
          <ThemeToggle />
        </div>
      </header>

      {open && (
        <>
          <button
            type="button"
            className="scrim"
            aria-label={t('shell.closeNav')}
            onClick={() => setOpen(false)}
          />
          <div
            className="drawer"
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={t('shell.navigation')}
          >
            <div className="drawer-head">
              <span className="wordmark" style={{ margin: 0, padding: 0 }}>
                <span className={`bulb ${liveCount > 0 ? 'on' : ''}`} />
                <span>{t('app.name')}</span>
              </span>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setOpen(false)}
                aria-label={t('shell.closeNav')}
              >
                <Icon name="close" />
              </button>
            </div>

            <nav>
              {nav.map((item) => (
                <NavLink
                  key={item.href}
                  href={item.href}
                  icon={item.icon}
                  onNavigate={() => setOpen(false)}
                  trailing={
                    item.href === '/activity' && liveCount > 0 ? <span className="bulb on" /> : null
                  }
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
                      onNavigate={() => setOpen(false)}
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

              <p className="group">{username}</p>
              <SignOutButton />
            </nav>
          </div>
        </>
      )}
    </>
  );
}
