'use client';

import { useSyncExternalStore } from 'react';
import { Icon } from './Icons';
import { useT } from '@/i18n/client';

export const THEME_KEY = 'watcharr-theme';

export type Theme = 'dark' | 'light';

// A view transition applies its change a frame or more after the call. Without remembering
// where we are headed, a quick second "t" would read the old scheme and repeat the first switch.
let heading: Theme | null = null;

function stampedTheme(): Theme {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === 'light' || stamped === 'dark') return stamped;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** The scheme in effect, or the one a switch in flight is about to apply. */
export function currentTheme(): Theme {
  return heading ?? stampedTheme();
}

/**
 * Runs `apply` inside a circular reveal that grows out of `origin` (default: screen
 * center), see shell.css. Browsers without view transitions, and people who asked for
 * less motion, just get the switch.
 */
export function revealTransition(apply: () => void, origin?: { x: number; y: number }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !('startViewTransition' in document)) {
    apply();
    return;
  }
  const root = document.documentElement;
  root.style.setProperty('--reveal-x', `${origin?.x ?? window.innerWidth / 2}px`);
  root.style.setProperty('--reveal-y', `${origin?.y ?? window.innerHeight / 2}px`);
  document.startViewTransition(apply);
}

/** Stamps the scheme on <html> and remembers it. Shared by the button and the `t` shortcut. */
export function applyTheme(next: Theme, origin?: { x: number; y: number }) {
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Private mode or a blocked origin: the choice just does not survive the tab.
  }
  heading = next;
  revealTransition(() => {
    document.documentElement.dataset.theme = next;
    if (heading === next) heading = null;
  }, origin);
}

// <html data-theme> is the source of truth (the boot script in the root layout sets it
// before first paint), so the button follows it instead of keeping its own copy: a
// keyboard shortcut or the palette can then flip the theme and the icon stays right.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const system = matchMedia('(prefers-color-scheme: light)');
  system.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    system.removeEventListener('change', onChange);
  };
}

/**
 * Flips the scheme by stamping data-theme on <html>. Reading it here during render would
 * show a dark flash on a light system, which is exactly the thing people notice; the
 * server snapshot is null, so the button hydrates as a stable box and fills in after.
 */
export default function ThemeToggle() {
  const t = useT();
  const theme = useSyncExternalStore<Theme | null>(subscribe, stampedTheme, () => null);

  function toggle(event: React.MouseEvent<HTMLButtonElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    applyTheme(currentTheme() === 'light' ? 'dark' : 'light', {
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
    });
  }

  const label = theme === 'light' ? t('theme.toDark') : t('theme.toLight');

  return (
    <button type="button" className="icon-btn" onClick={toggle} aria-label={label} data-tip={label}>
      <Icon name={theme === 'light' ? 'moon' : 'sun'} />
    </button>
  );
}
