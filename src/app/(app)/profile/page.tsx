import { formatDate } from '@/components/format';
import Pager, { pageOf } from '@/components/Pager';
import { BadgeShelf } from '@/components/Insights';
import LanguagePicker from '@/components/LanguagePicker';
import RevokeSessionButton from '@/components/RevokeSessionButton';
import Tabs, { activeTab, type TabDef } from '@/components/Tabs';
import { getSettings } from '@/server/config';
import { countDevices, getDevices } from '@/server/playback';
import { listUserSessions, requireUser } from '@/server/session';
import { LOCALE_NAMES, isLocale, type Translate } from '@/i18n';
import { getLocale, getT } from '@/i18n/server';
import ThemePicker from './ThemePicker';

export const dynamic = 'force-dynamic';

// Newsletter and event mails moved to /notifications — everything a user decides about
// being contacted sits in one place there.

const tabs = (t: Translate): TabDef[] => [
  { key: 'account', label: t('profile.tabAccount') },
  { key: 'sessions', label: t('profile.tabSessions') },
  { key: 'devices', label: t('ui2.devices.tab') },
];

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; page?: string | string[] }>;
}) {
  const { user, server } = await requireUser();
  const t = await getT();
  const locale = await getLocale();
  const params = await searchParams;
  const TABS = tabs(t);
  const tab = activeTab(TABS, params.tab);
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

  if (tab === 'devices') {
    // Through the same scope as every stream statistic: this person's sessions, nobody else's.
    const scope = { userId: user.id };
    const { page, pages, offset, limit } = pageOf(params.page, await countDevices(scope));
    const devices = await getDevices(scope, limit, offset);
    const network = { lan: t('stream.lan'), wan: t('stream.wan'), both: t('ui2.devices.both') };
    return (
      <>
        {head}
        <p className="subtitle" style={{ marginTop: -8 }}>
          {t('ui2.devices.subtitle')}
        </p>
        {devices.length === 0 ? (
          <div className="card empty">
            <p>{t('ui2.devices.empty')}</p>
          </div>
        ) : (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('common.device')}</th>
                  <th scope="col">{t('ui2.devices.client')}</th>
                  <th scope="col">{t('ui2.devices.lastSeen')}</th>
                  <th scope="col">{t('ui2.devices.plays')}</th>
                  <th scope="col" className="secondary-col">
                    {t('ui2.devices.network')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={`${device.device}\n${device.client}`}>
                    <td>{device.device}</td>
                    <td>{device.client}</td>
                    <td className="when-cell">{formatDate(device.lastSeen, locale)}</td>
                    <td className="num">{device.plays}</td>
                    <td className="secondary-col">
                      {device.network ? <span className="badge">{network[device.network]}</span> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} pages={pages} params={{ tab }} />
      </>
    );
  }

  if (tab === 'sessions') {
    // Rarely more than a handful, so the whole list is read and sliced here.
    const all = await listUserSessions(user.id);
    const { page, pages, offset, limit } = pageOf(params.page, all.length);
    const sessions = all.slice(offset, offset + limit);
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
                  <td>{formatDate(session.createdAt, locale)}</td>
                  <td>{formatDate(session.expiresAt, locale)}</td>
                  <td>
                    <RevokeSessionButton id={session.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager page={page} pages={pages} params={{ tab }} />
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
        {/* Language and scheme side by side: both follow the account, not the browser. */}
        <div className="card row" style={{ alignItems: 'flex-start', gap: '8px 28px' }}>
          <LanguagePicker current={user.locale} />
          <ThemePicker current={user.theme === 'dark' || user.theme === 'light' ? user.theme : null} />
        </div>
      </section>

      <section className="section">
        <h2>{t('ins.shelfTitle')}</h2>
        <BadgeShelf scope={{ userId: user.id }} />
      </section>
    </>
  );
}
