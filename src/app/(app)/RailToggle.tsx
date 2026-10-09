'use client';

import { Icon } from '@/components/Icons';
import { setRail, useRail } from '@/components/useRail';
import { useT } from '@/i18n/client';

/** Collapses the permanent sidebar to an icon rail, and back. Desktop only (CSS). */
export default function RailToggle() {
  const t = useT();
  const rail = useRail();
  const label = rail ? t('shell.expandNav') : t('shell.collapseNav');

  return (
    <button
      type="button"
      className="icon-btn rail-toggle"
      onClick={() => setRail(!rail)}
      aria-label={label}
      data-tip={label}
      data-tip-side="right"
    >
      <Icon name="panel" />
    </button>
  );
}
