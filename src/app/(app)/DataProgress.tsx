'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

/**
 * Says how far the background loading is. On a fresh install the library's posters and details
 * arrive over minutes to hours, and without this the pages just look empty with no hint why.
 * Polls slowly while there is a backlog, stops when it is done, and refreshes the page once so
 * the posters appear without a reload.
 */
export default function DataProgress() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const [progress, setProgress] = useState<{ cached: number; total: number } | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasLoading = false;

    async function poll() {
      try {
        const res = await fetch('/api/sync/status', { cache: 'no-store' });
        const body = res.ok ? ((await res.json()) as { artwork: { cached: number; total: number } | null }) : null;
        if (!alive) return;
        const loading = !!body?.artwork && body.artwork.cached < body.artwork.total;
        setProgress(loading ? body!.artwork : null);
        if (wasLoading && !loading) router.refresh();
        wasLoading = loading;
        if (loading) timer = setTimeout(poll, 8000);
      } catch {
        // Offline or signed out: the banner is a courtesy, stay quiet.
      }
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pathname, router]);

  if (!progress) return null;
  return (
    <div className="data-progress" role="status">
      <span>{t('progress.artwork', progress)}</span>
      <progress max={progress.total} value={progress.cached} />
    </div>
  );
}
