import { csvResponse, toCsv } from '@/server/csv';
import { visibleLibrary } from '@/server/library';
import { getSession } from '@/server/session';
import { unauthorized } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/**
 * The media info table as a file. Reads the user's own server: an account belongs to
 * exactly one, so there is no cross-server library to leak here.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();

  const sectionId = new URL(request.url).searchParams.get('sectionId');
  // Only what this person may open; a section id they cannot see yields an empty file.
  const all = await visibleLibrary(session).catch(() => []);
  const items = sectionId ? all.filter((item) => item.sectionId === sectionId) : all;

  const body = toCsv(
    ['Title', 'Type', 'Year', 'Genres', 'Resolution', 'Video codec', 'File size (MB)', 'Duration (min)', 'Added', 'Last played'],
    items.map((item) => [
      item.title,
      item.mediaType,
      item.year ?? '',
      item.genres.join('; '),
      item.height ? `${item.height}p` : '',
      item.videoCodec ?? '',
      item.fileSizeBytes ? Math.round(item.fileSizeBytes / 1_048_576) : '',
      item.durationMs ? Math.round(item.durationMs / 60000) : '',
      item.addedAt ? item.addedAt.toISOString() : '',
      item.lastPlayedAt ? item.lastPlayedAt.toISOString() : '',
    ]),
  );

  return csvResponse('watcharr-library.csv', body);
}
