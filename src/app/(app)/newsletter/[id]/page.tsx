import { notFound } from 'next/navigation';
import { formatDate } from '@/components/format';
import { getSettings } from '@/server/config';
import { requireUser } from '@/server/session';
import { getT } from '@/i18n/server';

// No loading.tsx in this segment: it calls notFound(). See the streaming note in CLAUDE.md.
export const dynamic = 'force-dynamic';

/**
 * The last sent issue, at the URL the admin picked. Behind a session on purpose — unlike
 * Tautulli's public link this would otherwise expose the library to anyone with the URL,
 * and a self-hosted install is exactly where that matters.
 */
export default async function NewsletterPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const t = await getT();
  const { id } = await params;
  const settings = await getSettings();

  if (id !== settings.newsletterUniqueId || !settings.newsletterLastHtml) notFound();

  return (
    <>
      <p className="eyebrow">{t('nav.adminNewsletter')}</p>
      <h1>{settings.newsletterSubject}</h1>
      <p className="subtitle">
        {settings.newsletterLastSentAt
          ? t('newsletter.issueSent', { date: formatDate(settings.newsletterLastSentAt) })
          : t('newsletter.latestIssue')}
      </p>

      {/* The stored HTML is built by server/newsletter.ts from escaped media server data,
          never from user input, and is rendered in an iframe so its inline mail styling
          cannot leak into the app's own stylesheet. */}
      <iframe
        title={settings.newsletterSubject}
        srcDoc={settings.newsletterLastHtml}
        sandbox=""
        style={{ width: '100%', height: '70vh', border: '1px solid var(--line)', borderRadius: 12 }}
      />
    </>
  );
}
