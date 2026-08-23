'use client';

import { useEffect } from 'react';

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
  useEffect(() => {
    // The server log is where the stack actually lives; this keeps the client copy
    // discoverable when someone is debugging from the browser.
    console.error(error);
  }, [error]);

  return (
    <div className="notice">
      <p className="eyebrow">Signal lost</p>
      <h1>Something stopped this page</h1>
      <p>
        The page could not be rendered. This is usually the media server being
        unreachable or slow to answer — the rest of Watcharr keeps working.
      </p>
      <div className="actions">
        <button onClick={reset}>Try again</button>
        <a href="/">Back to dashboard</a>
      </div>
      {error.digest && (
        <details>
          <summary>Technical detail</summary>
          <pre>Error reference: {error.digest}</pre>
        </details>
      )}
    </div>
  );
}
