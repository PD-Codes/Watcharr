import Link from 'next/link';
import type { TmdbMeta } from '@/server/tmdb';
import { getT } from '@/i18n/server';

// Server-rendered TMDB decoration for the two detail pages. Every piece returns null
// without data, so a deployment with no TMDB key renders exactly what it did before.

/**
 * Full-bleed backdrop behind a page header. The image sits in an inline style rather than
 * a CSS variable because the URL is per-title, and a gradient over it keeps the heading
 * readable no matter how bright the still is.
 */
export function Backdrop({ url }: { url?: string }) {
  if (!url) return null;
  return (
    <div className="backdrop" aria-hidden>
      <div className="backdrop-image" style={{ backgroundImage: `url(${JSON.stringify(url)})` }} />
    </div>
  );
}

/** Rating and runtime as a line of chips. Amber stays reserved for data, which this is. */
export async function TmdbFacts({ meta }: { meta: TmdbMeta | null }) {
  if (!meta) return null;
  const t = await getT();
  const facts = [
    meta.voteAverage
      ? `★ ${meta.voteAverage.toFixed(1)}${meta.voteCount ? ` (${meta.voteCount})` : ''}`
      : null,
    meta.runtimeMinutes ? t('meta.runtime', { minutes: meta.runtimeMinutes }) : null,
  ].filter(Boolean);
  if (!facts.length) return null;

  return (
    <ul className="chips">
      {facts.map((fact) => (
        <li key={fact}>
          <span className="badge num">{fact}</span>
        </li>
      ))}
    </ul>
  );
}

export function Overview({ meta }: { meta: TmdbMeta | null }) {
  if (!meta?.overview) return null;
  return (
    <p className="overview">
      {meta.tagline && <em className="tagline">{meta.tagline}</em>}
      {meta.overview}
    </p>
  );
}

/**
 * The cast, each face linking to that person's own page. Rendered only when TMDB returned
 * someone — an empty strip of placeholder circles says nothing.
 */
export function CastStrip({ cast, heading }: { cast: TmdbMeta['cast']; heading: string }) {
  if (!cast.length) return null;
  return (
    <section className="section">
      <h2>{heading}</h2>
      <div className="cast-strip">
        {cast.map((person) => (
          <Link key={person.id} className="cast-card" href={`/person/${person.id}`}>
            {person.profileUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img className="cast-photo" src={person.profileUrl} alt="" loading="lazy" />
            ) : (
              <span className="cast-photo poster-blank" aria-hidden />
            )}
            <span className="cast-name">{person.name}</span>
            {person.character && <span className="cast-role">{person.character}</span>}
          </Link>
        ))}
      </div>
    </section>
  );
}
