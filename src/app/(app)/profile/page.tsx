import { formatDate } from '@/components/format';
import RevokeSessionButton from '@/components/RevokeSessionButton';
import { getSettings } from '@/server/config';
import { getSubscription } from '@/server/newsletter';
import { listUserSessions, requireUser } from '@/server/session';
import NewsletterSubscription from './NewsletterSubscription';

export const dynamic = 'force-dynamic';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default async function ProfilePage() {
  const { user, server } = await requireUser();
  const [settings, subscription, sessions] = await Promise.all([
    getSettings(),
    getSubscription(user.id),
    listUserSessions(user.id),
  ]);

  const scheduleHint = settings.newsletterEnabled
    ? `Sent every ${DAYS[settings.newsletterDayOfWeek]} at ${String(settings.newsletterHour).padStart(2, '0')}:00, covering the last ${settings.newsletterDays} days.`
    : 'The newsletter is currently switched off by the administrator, but you can still subscribe for when it is turned on.';

  return (
    <>
      <p className="eyebrow">Account</p>
      <h1>{user.username}</h1>
      <p className="subtitle">
        Signed in through {server.label}
        {user.globalAdmin ? ' · global administrator' : user.isAdmin ? ' · administrator' : ''}
      </p>

      <section className="section">
        <h2>Newsletter</h2>
        <NewsletterSubscription
          subscribedEmail={subscription?.email ?? null}
          suggestedEmail={user.email ?? ''}
          scheduleHint={scheduleHint}
        />
      </section>

      <section className="section">
        <h2>Your sessions</h2>
        <p className="subtitle" style={{ marginTop: -8 }}>
          Every device currently signed in as you. Signing one out is immediate.
        </p>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Signed in</th>
                <th scope="col">Expires</th>
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
      </section>
    </>
  );
}
