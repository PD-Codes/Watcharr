import Link from 'next/link';

/**
 * Four routes already call notFound() — a missing title, an unknown user, and the two
 * feature toggles that hide suggestions and server-wide stats. Without this file all
 * four land on the stock Next.js 404.
 */
export default function NotFound() {
  return (
    <div className="notice">
      <p className="eyebrow">404</p>
      <h1>Nothing here</h1>
      <p>
        This page does not exist, or it belongs to a feature an admin has turned off for
        this deployment.
      </p>
      <div className="actions">
        <Link href="/">Back to dashboard</Link>
      </div>
    </div>
  );
}
