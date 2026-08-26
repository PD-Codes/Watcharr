'use client';

import { useEffect } from 'react';
import { useT } from '@/i18n/client';

/**
 * Route level error boundary. Without this any thrown render error — a media server
 * that went away mid-request is the common one — drops the visitor onto the stock
 * Next.js error screen, outside this app's world and with no way back.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();

  useEffect(() => {
    // The server log is where the stack actually lives; this keeps the client copy
    // discoverable when someone is debugging from the browser.
    console.error(error);
  }, [error]);

  return (
    <div className="notice">
      <p className="eyebrow">{t('error.signalLost')}</p>
      <h1>{t('error.page.title')}</h1>
      <p>{t('error.page.body')}</p>
      <div className="actions">
        <button onClick={reset}>{t('error.tryAgain')}</button>
        <a href="/">{t('error.backToDashboard')}</a>
      </div>
      {error.digest && (
        <details>
          <summary>{t('error.technicalDetail')}</summary>
          <pre>{t('error.reference', { digest: error.digest })}</pre>
        </details>
      )}
    </div>
  );
}
