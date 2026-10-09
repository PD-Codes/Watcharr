import { redirect } from 'next/navigation';
import { getSession } from '@/server/session';
import PlexDone from './PlexDone';

export const dynamic = 'force-dynamic';

/** Where plex.tv sends the browser after the PIN was approved. */
export default async function PlexDonePage({
  searchParams,
}: {
  searchParams: Promise<{ pin?: string; server?: string }>;
}) {
  // The login tab may have finished first; its cookie is shared.
  if (await getSession()) redirect('/watchlist');
  const { pin, server } = await searchParams;
  return (
    <div className="center card">
      <PlexDone pinId={/^\d{1,20}$/.test(pin ?? '') ? pin! : ''} serverId={Number(server) || 0} />
    </div>
  );
}
