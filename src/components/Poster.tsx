'use client';

import { useEffect, useRef, useState } from 'react';

/** Up to two initials, so an empty tile still says which title it stands for. */
function initials(label?: string): string {
  const words = (label ?? '').split(/[\s:·\-–—]+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Artwork with a fallback. The media server is asked first — it is local, and it is the
 * copy the user actually owns — but a library without artwork, or an item the proxy cannot
 * resolve, would otherwise leave a broken image on the page. A failed load falls through
 * to the TMDB poster, and after that to a tile carrying the title's initials.
 *
 * A client component only because `onError` has no server-rendered equivalent: there is no
 * way to know a URL is broken until the browser has tried it.
 */
export default function Poster({
  src,
  fallback,
  alt = '',
  label,
  className = 'poster',
  loading,
}: {
  src?: string;
  fallback?: string;
  alt?: string;
  /** The title, used for the initials on the placeholder tile. */
  label?: string;
  className?: string;
  loading?: 'lazy' | 'eager';
}) {
  const [current, setCurrent] = useState(src ?? fallback);
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);

  function fail() {
    if (fallback && current !== fallback) setCurrent(fallback);
    else setFailed(true);
  }

  // The server-rendered <img> can fail before React has hydrated, and React never replays
  // that missed `error` event — the broken-image glyph would stay. A finished load with no
  // pixels is the same failure, so it is checked once the element is mounted.
  useEffect(() => {
    const element = image.current;
    if (element?.complete && element.naturalWidth === 0) fail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  if (!current || failed) {
    return (
      <span className={`${className} poster-blank`} aria-hidden>
        <span>{initials(label ?? alt)}</span>
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={image}
      className={className}
      src={current}
      alt={alt}
      loading={loading}
      onError={fail}
    />
  );
}
