import { getT } from '@/i18n/server';

/**
 * Placeholder frame shown while a page streams in. Mirrors the real page shape —
 * eyebrow, title, subtitle, metric cards, then a block — so nothing jumps when the
 * content lands.
 */
export default async function PageSkeleton() {
  const t = await getT();
  return (
    <div className="skeleton" aria-busy="true" aria-live="polite">
      <span className="sr-only">{t('shell.loading')}</span>
      <div className="sk-line sk-eyebrow" />
      <div className="sk-line sk-title" />
      <div className="sk-line sk-subtitle" />
      <div className="sk-cards">
        <div className="sk-card" />
        <div className="sk-card" />
        <div className="sk-card" />
      </div>
      <div className="sk-block" />
    </div>
  );
}
