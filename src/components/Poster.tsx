'use client';

import { useState } from 'react';

/**
 * Artwork with a fallback. The media server is asked first — it is local, and it is the
 * copy the user actually owns — but a library without artwork, or an item the proxy cannot
 * resolve, would otherwise leave a broken image on the page. A failed load falls through
 * to the TMDB poster.
 *
 * A client component only because `onError` has no server-rendered equivalent: there is no
 * way to know a URL is broken until the browser has tried it.
 */
export default function Poster({
  src,
  fallback,
  alt = '',
  className = 'poster',
  loading,
}: {
  src?: string;
  fallback?: string;
  alt?: string;
  className?: string;
  loading?: 'lazy' | 'eager';
}) {
  const [current, setCurrent] = useState(src ?? fallback);
  const [failed, setFailed] = useState(false);

  if (!current || failed) return <span className={`${className} poster-blank`} aria-hidden />;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={current}
      alt={alt}
      loading={loading}
      onError={() => {
        if (fallback && current !== fallback) setCurrent(fallback);
        else setFailed(true);
      }}
    />
  );
}
