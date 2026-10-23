import { redirect } from 'next/navigation';
import { isAdmin, requireUser } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Bare /screen (nav, manifest shortcut, "g c") lands on the view that reader would want. */
export default async function ScreenIndex() {
  const session = await requireUser();
  redirect(isAdmin(session.user) ? '/screen/server' : '/screen/me');
}
