import { notFound } from 'next/navigation';
import { formatDate } from '@/components/format';
import { getNewsletterArchive, getSettings } from '@/server/config';
import { sectionKey, sessionAccess } from '@/server/library';
import { canReadIssue } from '@/server/newsletter';
import { isAdmin, requireUser } from '@/server/session';
import { getLocale, getT } from '@/i18n/server';

// No loading.tsx in this segment: it calls notFound(). See the streaming note in CLAUDE.md.
export const dynamic = 'force-dynamic';

/**
 * The last sent issue, at the URL the admin picked. Behind a session on purpose — unlike
 * Tautulli's public link this would otherwise expose the library to anyone with the URL,
 * and a self-hosted install is exactly where that matters.
 */
export default async function NewsletterPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireUser();
  const t = await getT();
  const locale = await getLocale();
  const { id } = await params;
  const settings = await getSettings();
  if (id !== settings.newsletterUniqueId) notFound();
  const archive = await getNewsletterArchive();
  if (!archive.html) notFound();
  // The stored issue is the full one. Somebody who may not open every library in it got their
  // own cut by mail, and reading the full one here would show them the rest.
  let readable = isAdmin(session.user);
  if (!readable) {
    const access = await sessionAccess(session).catch(() => null);
    const visible = new Set(access && !access.all ? [...access.ids].map((id) => sectionKey(session.user.serverId, id)) : []);
    readable = canReadIssue(archive.libraries, visible);
  }
  if (!readable) {
    return (
      <>
        <p className="eyebrow">{t('nav.adminNewsletter')}</p>
        <h1>{settings.newsletterSubject}</h1>
        <p className="subtitle">{t('fix2.newsletter.notForYou')}</p>
      </>
    );
  }
  // The issue in the reader's language when it was rendered in it (issues sent before the
  // per-language copy existed only have the default one).
  const html = archive.byLocale?.[locale] ?? archive.html;

  return (
    <>
      <p className="eyebrow">{t('nav.adminNewsletter')}</p>
      <h1>{settings.newsletterSubject}</h1>
      <p className="subtitle">
        {settings.newsletterLastSentAt
          ? t('newsletter.issueSent', { date: formatDate(settings.newsletterLastSentAt, locale) })
          : t('newsletter.latestIssue')}
      </p>

      {/* The stored HTML is built by server/newsletter.ts from escaped media server data,
          never from user input, and is rendered in an iframe so its inline mail styling
          cannot leak into the app's own stylesheet. */}
      <iframe
        title={settings.newsletterSubject}
        srcDoc={html}
        sandbox=""
        style={{ width: '100%', height: '70vh', border: '1px solid var(--line)', borderRadius: 12 }}
      />
    </>
  );
}
