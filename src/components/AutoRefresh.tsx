'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-renders the surrounding server component on an interval — used for live activity.
 * A hidden tab does not poll, and coming back to it refreshes at once instead of showing
 * whatever was true when the tab was left.
 */
export default function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) router.refresh();
    };
    const timer = setInterval(refresh, seconds * 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [router, seconds]);
  return null;
}
