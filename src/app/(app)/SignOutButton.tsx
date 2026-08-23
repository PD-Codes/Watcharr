'use client';

import { useRouter } from 'next/navigation';
import { t } from '@/i18n';

export default function SignOutButton() {
  const router = useRouter();
  return (
    <a
      href="/login"
      onClick={async (event) => {
        event.preventDefault();
        await fetch('/api/auth/logout', { method: 'POST' });
        router.push('/login');
      }}
    >
      {t('action.signOut')}
    </a>
  );
}
