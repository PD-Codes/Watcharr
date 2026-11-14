import Link from 'next/link';
import { redirect } from 'next/navigation';
import { hasGlobalAdmin } from '@/server/adminrecovery';
import { listServers } from '@/server/config';
import { getRealSession } from '@/server/session';
import { getT } from '@/i18n/server';
import AdminLogin from './AdminLogin';

export const dynamic = 'force-dynamic';

/** Admin access for when the media server cannot sign anyone in (see server/adminrecovery.ts). */
export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  if (!(await listServers()).length) redirect('/setup');
  if ((await getRealSession())?.user.globalAdmin) redirect('/');
  const t = await getT();
  // Only prefilled, never redeemed on GET: a link preview or prefetch must not use up the code.
  const token = (await searchParams).token?.slice(0, 64) ?? '';
  const adminExists = await hasGlobalAdmin();

  return (
    <div className="center card">
      <h1>{t('adminlogin.title')}</h1>
      <p className="subtitle">{t('adminlogin.intro')}</p>
      {!adminExists && <p className="muted">{t('adminlogin.noAdmin')}</p>}
      <AdminLogin initialCode={token} />
      <p className="muted">
        <Link href="/login">{t('login.backToLogin')}</Link>
      </p>
    </div>
  );
}
