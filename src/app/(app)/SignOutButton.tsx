'use client';

import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

export default function SignOutButton() {
  const router = useRouter();
  const t = useT();
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
