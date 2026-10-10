import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { readConfirmation } from '@/server/mailconfirm';
import { subscribe } from '@/server/newsletter';

export const dynamic = 'force-dynamic';

/** The link from a confirmation mail: proves the address belongs to whoever asked for it. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const confirmed = readConfirmation(url.searchParams);
  const target = new URL('/notifications', url);
  if (!confirmed) {
    target.searchParams.set('mail', 'invalid');
    return NextResponse.redirect(target);
  }
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, confirmed.userId));
  if (user) {
    if (confirmed.kind === 'newsletter') await subscribe(user.id, confirmed.address);
    else await db.update(users).set({ notifyEmail: confirmed.address }).where(eq(users.id, user.id));
  }
  target.searchParams.set('mail', user ? 'confirmed' : 'invalid');
  return NextResponse.redirect(target);
}
