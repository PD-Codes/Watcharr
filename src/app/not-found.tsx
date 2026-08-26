import Link from 'next/link';
import { getT } from '@/i18n/server';

/**
 * Four routes already call notFound() — a missing title, an unknown user, and the two
 * feature toggles that hide suggestions and server-wide stats. Without this file all
 * four land on the stock Next.js 404.
 */
export default async function NotFound() {
  const t = await getT();

  return (
    <div className="notice">
      <p className="eyebrow">404</p>
      <h1>{t('error.notFound.title')}</h1>
      <p>{t('error.notFound.body')}</p>
      <div className="actions">
        <Link href="/">{t('error.backToDashboard')}</Link>
      </div>
    </div>
  );
}
