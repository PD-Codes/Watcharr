'use client';

import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icons';
import { useRail } from '@/components/useRail';
import { useT } from '@/i18n/client';

export default function SignOutButton() {
  const router = useRouter();
  const t = useT();
  const rail = useRail();
  const label = t('action.signOut');

  return (
    <a
      href="/login"
      data-tip={rail ? label : undefined}
      data-tip-side="right"
      onClick={async (event) => {
        event.preventDefault();
        await fetch('/api/auth/logout', { method: 'POST' });
        router.push('/login');
      }}
    >
      <span className="nav-label">
        <Icon name="logout" />
        <span className="nav-text">{label}</span>
      </span>
    </a>
  );
}
