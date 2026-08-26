import Link from 'next/link';

/**
 * The one way a played item is linked in a list. An episode row used to link only to its
 * show, which meant the episode page existed but was reachable from almost nowhere — every
 * table had to remember to render the second link, and most did not.
 *
 * Shows go to /title (episodes grouped, 30-day chart, viewers); an episode goes to /item,
 * which is the same view for that one item. A movie has no second level, so its single
 * link leads to /title as well.
 */
export default function TitleLink({
  itemId,
  title,
  grandparentTitle,
  serverWide = false,
}: {
  itemId: string;
  title: string;
  grandparentTitle?: string | null;
  /** Carries ?scope=server through, so an admin drilling down stays server-wide. */
  serverWide?: boolean;
}) {
  const query = serverWide ? '?scope=server' : '';

  if (!grandparentTitle) {
    return <Link href={`/title/${encodeURIComponent(title)}${query}`}>{title}</Link>;
  }

  return (
    <>
      <Link href={`/title/${encodeURIComponent(grandparentTitle)}${query}`}>{grandparentTitle}</Link>
      <div style={{ fontSize: 12 }}>
        <Link className="muted" href={`/item/${encodeURIComponent(itemId)}${query}`}>
          {title}
        </Link>
      </div>
    </>
  );
}
