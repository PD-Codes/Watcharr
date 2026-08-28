import { formatDate } from '@/components/format';
import LanguagePicker from '@/components/LanguagePicker';
import RevokeSessionButton from '@/components/RevokeSessionButton';
import Tabs, { activeTab, type TabDef } from '@/components/Tabs';
import { getSettings } from '@/server/config';
import { listUserSessions, requireUser } from '@/server/session';
import { LOCALE_NAMES, isLocale, type Translate } from '@/i18n';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

// Newsletter and event mails moved to /notifications — everything a user decides about
// being contacted sits in one place there.

const tabs = (t: Translate): TabDef[] => [
  { key: 'account', label: t('profile.tabAccount') },
  { key: 'sessions', label: t('profile.tabSessions') },
];

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { user, server } = await requireUser();
  const t = await getT();
  const TABS = tabs(t);
  const tab = activeTab(TABS, (await searchParams).tab);
  const settings = await getSettings();

  const head = (
    <>
      <p className="eyebrow">{t('profile.eyebrow')}</p>
      <h1>{user.username}</h1>
      <p className="subtitle">
        {t('profile.signedInThrough', { server: server.label })}
        {user.globalAdmin
          ? ` · ${t('profile.globalAdminSuffix')}`
          : user.isAdmin
            ? ` · ${t('common.administrator')}`
            : ''}
      </p>
      <Tabs tabs={TABS} current={tab} hrefFor={(key) => `/profile?tab=${key}`} />
    </>
  );

  if (tab === 'sessions') {
    const sessions = await listUserSessions(user.id);
    return (
      <>
        {head}
        <p className="subtitle" style={{ marginTop: -8 }}>
          {t('profile.sessionsSubtitle')}
        </p>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('profile.signedInCol')}</th>
                <th scope="col">{t('profile.expiresCol')}</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>{formatDate(session.createdAt)}</td>
                  <td>{formatDate(session.expiresAt)}</td>
                  <td>
                    <RevokeSessionButton id={session.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  const inherited = isLocale(settings.defaultLocale)
    ? LOCALE_NAMES[settings.defaultLocale]
    : settings.defaultLocale;

  return (
    <>
      {head}
      <section>
        <h2>{t('profile.language.label')}</h2>
        <p className="subtitle" style={{ marginTop: -8 }}>
          {t('profile.languageHint', { default: inherited })}
        </p>
        <div className="card">
          <LanguagePicker current={user.locale} />
        </div>
      </section>
    </>
  );
}
