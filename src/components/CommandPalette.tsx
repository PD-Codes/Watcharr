'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Icon } from './Icons';
import { useT } from '@/i18n/client';

/** Anything can ask for the palette by firing this on window — no context provider needed. */
export const OPEN_SEARCH_EVENT = 'watcharr:search';

interface SearchResult {
  kind: 'title' | 'library' | 'user';
  label: string;
  sub?: string;
  href: string;
}

export default function CommandPalette() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults([]);
    setCursor(0);
  }, []);

  // Cmd/Ctrl+K anywhere, plus the button in the drawer and the app bar.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((wasOpen) => !wasOpen);
      }
    }
    const onRequest = () => setOpen(true);

    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_SEARCH_EVENT, onRequest);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_SEARCH_EVENT, onRequest);
    };
  }, []);

  // A navigation is always the end of a search.
  useEffect(close, [pathname, close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Debounced, and the in-flight request is aborted so a slow answer for "bl" cannot
  // land after the answer for "blade" and overwrite it.
  useEffect(() => {
    const term = query.trim();
    if (!open || term.length < 2) {
      setResults([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = (await response.json()) as { results?: SearchResult[] };
        setResults(body.results ?? []);
        setCursor(0);
      } catch {
        // Aborted or offline — the previous list stays until the next keystroke.
      }
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);

  if (!open) return null;

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!results.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setCursor((index) => (index + step + results.length) % results.length);
      return;
    }
    if (event.key === 'Enter' && results[cursor]) {
      event.preventDefault();
      router.push(results[cursor].href);
      close();
    }
  }

  const term = query.trim();
  const kindLabel: Record<SearchResult['kind'], string> = {
    title: t('common.watched'),
    library: t('palette.library'),
    user: t('common.user'),
  };

  return (
    <div
      className="palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('action.search')}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('palette.placeholder')}
          aria-label={t('action.search')}
        />

        {results.length > 0 ? (
          <ul className="palette-list">
            {results.map((result, index) => (
              <li
                key={`${result.kind}-${result.href}-${result.label}`}
                className={`palette-item ${index === cursor ? 'on' : ''}`}
                onMouseEnter={() => setCursor(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  router.push(result.href);
                  close();
                }}
              >
                <span className="palette-kind">{kindLabel[result.kind]}</span>
                <span className="label">{result.label}</span>
                {result.sub && <span className="sub">{result.sub}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="palette-empty">
            {term.length < 2 ? t('palette.typeMore') : t('palette.noMatches')}
          </p>
        )}

        <p className="palette-hint">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> {t('palette.move')}
          </span>
          <span>
            <kbd>↵</kbd> {t('palette.open')}
          </span>
          <span>
            <kbd>esc</kbd> {t('palette.close')}
          </span>
        </p>
      </div>
    </div>
  );
}

/** The affordance that tells people the palette exists at all. */
export function SearchTrigger({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const fire = () => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT));

  if (compact) {
    return (
      <button type="button" className="icon-btn" onClick={fire} aria-label={t('action.search')}>
        <Icon name="search" />
      </button>
    );
  }

  return (
    <button type="button" className="search-trigger" onClick={fire}>
      <Icon name="search" />
      {t('action.search')}
      <kbd>⌘K</kbd>
    </button>
  );
}
