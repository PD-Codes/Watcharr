'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Re-renders the surrounding server component on an interval — used for live activity. */
export default function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
