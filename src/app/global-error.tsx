'use client';

/**
 * Last resort: an error thrown by the root layout itself replaces the whole document,
 * so this boundary has to bring its own <html> and <body> and cannot rely on globals.css
 * having been applied. Kept deliberately plain and dependency free.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          background: '#08090b',
          color: '#e9ebef',
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 420 }}>
          <p
            style={{
              margin: '0 0 6px',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: '#ffb020',
            }}
          >
            Signal lost
          </p>
          <h1 style={{ margin: '0 0 8px', fontSize: 25, lineHeight: 1.15 }}>
            Watcharr could not start
          </h1>
          <p style={{ margin: '0 0 20px', color: '#8a919f', fontSize: 14, lineHeight: 1.5 }}>
            The application shell failed to render. Check that the database file is readable
            and that SESSION_SECRET is set, then try again.
          </p>
          <button
            onClick={reset}
            style={{
              padding: '9px 16px',
              minHeight: 44,
              background: '#e9ebef',
              color: '#08090b',
              border: 0,
              borderRadius: 6,
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p style={{ marginTop: 18, fontSize: 11.5, color: '#7d8494' }}>
              Error reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
