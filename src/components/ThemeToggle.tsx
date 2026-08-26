'use client';

import { useEffect, useState } from 'react';
import { Icon } from './Icons';
import { useT } from '@/i18n/client';

export const THEME_KEY = 'watcharr-theme';

type Theme = 'dark' | 'light';

/**
 * Flips the scheme by stamping data-theme on <html>. The initial value is applied by the
 * inline script in the root layout, before first paint — reading it here instead would
 * show a dark flash on a light system, which is exactly the thing people notice.
 */
export default function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.dataset.theme as Theme | undefined;
    setTheme(current ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  }, []);

  function toggle() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode or a blocked origin: the choice just does not survive the tab.
    }
    setTheme(next);
  }

  // Rendered as a stable box before hydration so the app bar does not jump.
  const label = theme === 'light' ? t('theme.toDark') : t('theme.toLight');

  return (
    <button type="button" className="icon-btn" onClick={toggle} aria-label={label} data-tip={label}>
      <Icon name={theme === 'light' ? 'moon' : 'sun'} />
    </button>
  );
}
