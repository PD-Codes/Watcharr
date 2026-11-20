'use client';

import { useState } from 'react';
import { applyTheme, followSystemTheme, type Theme } from '@/components/ThemeToggle';
import { useT } from '@/i18n/client';

/**
 * The only place to go back to "follow the system" — the toggle in the top bar can only
 * flip between dark and light. `current` is what the account stores (null = system).
 */
export default function ThemePicker({ current }: { current: Theme | null }) {
  const t = useT();
  const [value, setValue] = useState<Theme | 'system'>(current ?? 'system');

  function choose(next: Theme | 'system') {
    setValue(next);
    if (next === 'system') followSystemTheme();
    else applyTheme(next);
  }

  return (
    <div className="filters">
      <label>
        {t('ui2.theme.label')}
        <select value={value} onChange={(event) => choose(event.target.value as Theme | 'system')}>
          <option value="system">{t('ui2.theme.system')}</option>
          <option value="dark">{t('ui2.theme.dark')}</option>
          <option value="light">{t('ui2.theme.light')}</option>
        </select>
      </label>
    </div>
  );
}
