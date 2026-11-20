'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/Icons';
import ThemeToggle from '@/components/ThemeToggle';
import { SearchTrigger } from '@/components/CommandPalette';
import NavLink from './NavLink';
import SignOutButton from './SignOutButton';
import { useRail } from '@/components/useRail';
import { activeGroup, openGroups, parseRemembered, type NavGroup, type NavItem } from './nav';
import { useT } from '@/i18n/client';

const GROUPS_KEY = 'watcharr-nav-groups';

/**
 * Mobile chrome: a top app bar plus a modal navigation drawer. Below 880px the permanent
 * drawer is hidden by CSS, so this is the only way to reach the admin routes that do not
 * fit in the five-slot bottom bar.
 */
export default function AppBar({
  username,
  liveCount,
  playingCount,
  minePlaying,
  nav,
  adminGroups,
  updateAvailable,
}: {
  username: string;
  liveCount: number;
  /** Streams that are actually running: only these light the bulb. */
  playingCount: number;
  /** The viewer's own running streams: the dot on the personal Activity entry. */
  minePlaying: number;
  nav: NavItem[];
  adminGroups: NavGroup[];
  updateAvailable: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panel = useRef<HTMLDivElement>(null);

  // Arriving somewhere new is the end of navigating.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pathname is the trigger: a navigation closes the drawer
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
          <span className={`bulb ${playingCount > 0 ? 'on' : ''}`} />
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
                <span className={`bulb ${playingCount > 0 ? 'on' : ''}`} />
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
                    item.href === '/activity' && minePlaying > 0 ? <span className="bulb on" /> : null
                  }
                >
                  {item.label}
                </NavLink>
              ))}

              <AdminNav
                groups={adminGroups}
                liveCount={liveCount}
                updateAvailable={updateAvailable}
                onNavigate={() => setOpen(false)}
              />

              <p className="group">{username}</p>
              <SignOutButton />
            </nav>
          </div>
        </>
      )}
    </>
  );
}

/**
 * The admin destinations as collapsible groups, shared by the permanent drawer and the modal
 * one. Only the group of the current page is open by default; opening or closing one is
 * remembered per browser. The remembered part is read after hydration, so the server markup
 * (current group open) and the first client render agree.
 */
export function AdminNav({
  groups,
  liveCount,
  updateAvailable,
  onNavigate,
}: {
  groups: NavGroup[];
  liveCount: number;
  updateAvailable: boolean;
  onNavigate?: () => void;
}) {
  const t = useT();
  const pathname = usePathname();
  const rail = useRail();
  const idPrefix = useId();
  const [remembered, setRemembered] = useState<Record<string, boolean>>({});
  const [activeClosed, setActiveClosed] = useState(false);

  useEffect(() => {
    try {
      setRemembered(parseRemembered(localStorage.getItem(GROUPS_KEY)));
    } catch {
      // Blocked storage: every visit starts with only the current group open.
    }
  }, []);

  // A new page opens its own group again, even if it was closed on the previous one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pathname is the trigger: a new page reopens its own group
  useEffect(() => setActiveClosed(false), [pathname]);

  if (groups.length === 0) return null;

  const active = activeGroup(groups, pathname);
  const open = openGroups(
    groups.map((group) => group.key),
    active,
    remembered,
    activeClosed,
  );

  function toggle(key: string) {
    const next = !open[key];
    if (key === active) setActiveClosed(!next);
    const updated = { ...remembered, [key]: next };
    setRemembered(updated);
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify(updated));
    } catch {
      // The choice lasts for this tab only.
    }
  }

  const updateMark = (
    <span className="badge nav-update" data-tip={t('ui2.nav.updateTip')}>
      {t('ui2.nav.update')}
    </span>
  );

  return (
    <>
      <p className="group">{t('nav.admin')}</p>
      {groups.map((group) => {
        const isOpen = open[group.key];
        const panelId = `${idPrefix}-${group.key}`;
        const hasLive = group.items.some((item) => item.href === '/admin/activity') && liveCount > 0;
        const hasUpdate = updateAvailable && group.items.some((item) => item.href === '/admin/system');
        return (
          <div key={group.key} className="nav-group" data-open={isOpen ? '1' : undefined}>
            <button
              type="button"
              className={`nav-group-head${group.key === active ? ' current' : ''}`}
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => toggle(group.key)}
              data-tip={rail ? group.label : undefined}
              data-tip-side="right"
            >
              <span className="nav-label">
                <Icon name={group.icon} />
                <span className="nav-text">{group.label}</span>
              </span>
              {/* What a closed group hides is still announced on its head: a running stream
                  (data, so amber) and a pending update (neutral). */}
              {!isOpen && hasLive && <span className="badge live">{liveCount}</span>}
              {!isOpen && hasUpdate && updateMark}
              <Icon name="chevron" className="nav-chevron" />
            </button>
            <div id={panelId} className="nav-group-items" hidden={!isOpen}>
              {group.items.map((item) => (
                <NavLink
                  key={item.href}
                  href={item.href}
                  icon={item.icon}
                  onNavigate={onNavigate}
                  trailing={
                    item.href === '/admin/activity' && liveCount > 0 ? (
                      <span className="badge live">{liveCount}</span>
                    ) : item.href === '/admin/system' && updateAvailable ? (
                      updateMark
                    ) : null
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
