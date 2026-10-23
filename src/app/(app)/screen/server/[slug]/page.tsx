import ScreenView from '../../ScreenView';

export const dynamic = 'force-dynamic';

export default async function ScreenServerSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  return <ScreenView kind="server" slug={(await params).slug} />;
}
