'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Icon, type IconName } from './Icons';
import { highlightRuns } from './fuzzy';
import {
  buildSections,
  flatten,
  parseRecent,
  pushRecent,
  type Candidate,
  type RecentEntry,
  type Row,
} from './palette-core';
import { COMMAND_EVENT, OPEN_SEARCH_EVENT, goKeysFor } from './shortcuts-core';
import { currentTheme } from './ThemeToggle';
import { trapTab, useDialog } from './overlay';
import { useRail } from './useRail';
import { useT } from '@/i18n/client';
import './shortcuts.css';

export { OPEN_SEARCH_EVENT };

/** A destination the palette can jump to; the layout passes the full navigation, admin items included. */
export interface PalettePage {
  href: string;
  label: string;
  icon: IconName;
}

interface SearchResult {
  kind: 'title' | 'library' | 'user';
  label: string;
  sub?: string;
  href: string;
}

const NO_PAGES: PalettePage[] = [];
const RECENT_KEY = 'watcharr-palette-recent';
const KIND_ICON: Record<SearchResult['kind'], IconName> = {
  title: 'film',
  library: 'server',
  user: 'users',
};
const PAGE_JUMP = 6;

/**
 * Search, pages and actions in one list. `userKey` scopes the "Recent" list in this
 * browser's storage; without it a second account on the same browser would see the first
 * one's recently opened titles.
 */
export default function CommandPalette({
  pages = NO_PAGES,
  userKey,
}: {
  pages?: PalettePage[];
  userKey?: string | number;
}) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const rail = useRail();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  // Has the person picked a row themselves since the last keystroke? If so, results that
  // arrive late must not yank the selection back to the top.
  const pickedRef = useRef(false);
  const scrollRef = useRef(false);

  const storageKey = userKey === undefined ? RECENT_KEY : `${RECENT_KEY}:${userKey}`;

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults([]);
    setSearching(false);
    setActiveId(null);
    pickedRef.current = false;
  }, []);

  const show = useCallback(() => {
    try {
      setRecent(parseRecent(localStorage.getItem(storageKey)));
    } catch {
      setRecent([]);
    }
    setOpen(true);
  }, [storageKey]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Cmd/Ctrl+K anywhere, plus the button in the drawer and the app bar.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (openRef.current) close();
        else show();
      }
    }

    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_SEARCH_EVENT, show);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_SEARCH_EVENT, show);
    };
  }, [close, show]);

  // A navigation is always the end of a search.
  useEffect(close, [pathname, close]);

  useDialog(open, inputRef);

  // Debounced, and the in-flight request is aborted so a slow answer for "bl" cannot
  // land after the answer for "blade" and overwrite it.
  useEffect(() => {
    const term = query.trim();
    if (!open || term.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = (await response.json()) as { results?: SearchResult[] };
        setResults(body.results ?? []);
        if (!pickedRef.current) setActiveId(null);
      } catch {
        // Aborted or offline — the previous list stays until the next keystroke.
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);

  const sections = useMemo(() => {
    if (!open) return [];
    const theme = currentTheme();
    const cinema = document.documentElement.dataset.cinema === '1';
    // Below 881px the sidebar is not shown, so collapsing it is not an action.
    const hasSidebar = matchMedia('(min-width: 881px)').matches;
    const kindLabel: Record<SearchResult['kind'], string> = {
      title: t('common.watched'),
      library: t('palette.library'),
      user: t('common.user'),
    };

    const actions: Candidate[] = [
      {
        id: 'action:theme',
        label: t('kbd.actTheme'),
        icon: theme === 'light' ? 'moon' : 'sun',
        keywords: t('kbd.themeKeywords'),
        keys: ['t'],
        command: 'theme',
      },
      ...(hasSidebar
        ? [
            {
              id: 'action:rail',
              label: t(rail ? 'kbd.actRailExpand' : 'kbd.actRailCollapse'),
              icon: 'panel' as const,
              keywords: t('kbd.railKeywords'),
              keys: ['['],
              command: 'rail' as const,
            },
          ]
        : []),
      {
        id: 'action:cinema',
        label: t(cinema ? 'kbd.actCinemaOff' : 'kbd.actCinemaOn'),
        icon: 'monitor',
        keywords: t('kbd.cinemaKeywords'),
        keys: ['c'],
        command: 'cinema',
      },
      {
        id: 'action:help',
        label: t('kbd.actHelp'),
        icon: 'keyboard',
        keywords: t('kbd.helpKeywords'),
        keys: ['?'],
        command: 'help',
      },
      {
        id: 'action:pick',
        label: t('kbd.actPick'),
        icon: 'dice',
        keywords: t('kbd.pickKeywords'),
        keys: goKeysFor('/pick') ?? undefined,
        href: '/pick',
      },
    ];

    const pageRows: Candidate[] = pages.map((page) => ({
      id: `page:${page.href}`,
      label: page.label,
      icon: page.icon,
      // "Users" and "Notifications" exist twice (yours and the admin one); say which is which.
      sub: page.href.startsWith('/admin') ? t('nav.admin') : undefined,
      keywords: page.href.startsWith('/admin') ? `${t('nav.admin')} ${page.label}` : undefined,
      href: page.href,
      keys: goKeysFor(page.href) ?? undefined,
      recent: { href: page.href, label: page.label, kind: 'page' },
    }));

    // A remembered page that is no longer in the navigation (rights changed) is skipped.
    const recentRows: Candidate[] = recent.flatMap((entry): Candidate[] => {
      const page = entry.kind === 'page' ? pages.find((p) => p.href === entry.href) : undefined;
      if (entry.kind === 'page' && !page) return [];
      return [
        {
          id: `recent:${entry.href}`,
          label: page?.label ?? entry.label,
          icon: page?.icon ?? KIND_ICON[entry.kind as SearchResult['kind']],
          sub: entry.sub,
          tag: page ? undefined : kindLabel[entry.kind as SearchResult['kind']],
          href: entry.href,
          recent: entry,
        },
      ];
    });

    const resultRows: Candidate[] = results.map((result) => ({
      id: `result:${result.kind}:${result.href}:${result.label}`,
      label: result.label,
      icon: KIND_ICON[result.kind],
      sub: result.sub,
      tag: kindLabel[result.kind],
      href: result.href,
      recent: { href: result.href, label: result.label, sub: result.sub, kind: result.kind },
    }));

    return buildSections(query, { recent: recentRows, actions, pages: pageRows, results: resultRows });
  }, [open, query, results, recent, pages, rail, t]);

  const rows = useMemo(() => flatten(sections), [sections]);
  const found = rows.findIndex((row) => row.id === activeId);
  const activeIndex = found < 0 ? 0 : found;
  const optionId = (index: number) => `${uid}-o${index}`;

  // Keep the keyboard selection in view. A first row brings its group heading along.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current = false;
    const row = rows[activeIndex];
    if (!row) return;
    const first = rows.findIndex((r) => r.group === row.group) === activeIndex;
    const target = first
      ? document.getElementById(`${uid}-g-${row.group}`)
      : document.getElementById(optionId(activeIndex));
    target?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, rows, uid]);

  if (!open) return null;

  function remember(entry: RecentEntry) {
    try {
      const stored = parseRecent(localStorage.getItem(storageKey));
      localStorage.setItem(storageKey, JSON.stringify(pushRecent(stored, entry)));
    } catch {
      // Storage blocked: the list just stays empty.
    }
  }

  function activate(row: Row) {
    if (row.recent) remember(row.recent);
    close();
    if (row.command) {
      // After the palette has left the page, so a theme reveal does not capture it.
      const detail = row.command;
      setTimeout(() => window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail })), 0);
    } else if (row.href) {
      router.push(row.href);
    }
  }

  function moveTo(index: number) {
    if (rows.length === 0) return;
    pickedRef.current = true;
    scrollRef.current = index !== activeIndex;
    setActiveId(rows[index].id);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    // Enter and the arrows belong to the input method while a composition is open.
    if (event.nativeEvent.isComposing) return;
    const last = rows.length - 1;

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close();
        return;
      case 'Tab':
        if (panelRef.current) trapTab(event, panelRef.current);
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        moveTo((activeIndex + step + rows.length) % Math.max(rows.length, 1));
        return;
      }
      case 'PageDown':
      case 'PageUp': {
        event.preventDefault();
        const step = event.key === 'PageDown' ? PAGE_JUMP : -PAGE_JUMP;
        moveTo(Math.min(Math.max(activeIndex + step, 0), Math.max(last, 0)));
        return;
      }
      case 'Home':
      case 'End':
        // Shift and Ctrl+Home keep their text-editing meaning in the field.
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        moveTo(event.key === 'Home' ? 0 : Math.max(last, 0));
        return;
      case 'Enter':
        if (rows[activeIndex]) {
          event.preventDefault();
          activate(rows[activeIndex]);
        }
        return;
    }
  }

  const term = query.trim();
  const status = term && !searching ? t('kbd.resultsCount', { count: rows.length }) : '';
  const heading: Record<Row['group'], string> = {
    recent: t('kbd.recent'),
    actions: t('kbd.actions'),
    pages: t('kbd.pages'),
    results: t('kbd.results'),
  };

  let index = -1;

  return (
    <div
      className="palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('action.search')}
        onKeyDown={onKeyDown}
        // Clicking dead space in the panel must not pull focus out of the field.
        onMouseDown={(event) => {
          if (!(event.target as HTMLElement).closest('input, button')) event.preventDefault();
        }}
      >
        <div className="pal-head">
          <Icon name="search" className="pal-lens" />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveId(null);
              pickedRef.current = false;
            }}
            placeholder={t('kbd.placeholder')}
            aria-label={t('action.search')}
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={`${uid}-list`}
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-activedescendant={rows.length > 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
          />
          <button type="button" className="icon-btn pal-close" onClick={close} aria-label={t('kbd.close')}>
            <Icon name="close" />
          </button>
        </div>

        <div
          id={`${uid}-list`}
          className="palette-list"
          role="listbox"
          aria-label={t('kbd.listLabel')}
          aria-busy={searching}
        >
          {sections.map((section) => (
            <div key={section.group} role="group" aria-labelledby={`${uid}-g-${section.group}`}>
              <div id={`${uid}-g-${section.group}`} className="pal-group" role="presentation">
                {heading[section.group]}
              </div>
              {section.rows.map((row) => {
                index += 1;
                const mine = index;
                const active = mine === activeIndex;
                return (
                  <div
                    key={row.id}
                    id={optionId(mine)}
                    role="option"
                    aria-selected={active}
                    aria-keyshortcuts={row.keys?.length === 1 ? row.keys[0] : undefined}
                    className={`palette-item pal-row ${active ? 'on' : ''}`}
                    onMouseMove={() => {
                      if (!active) {
                        pickedRef.current = true;
                        setActiveId(row.id);
                      }
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => activate(row)}
                  >
                    <Icon name={row.icon} className="pal-icon" />
                    <span className="label">
                      {highlightRuns(row.label, row.hit).map((run, i) =>
                        run.hit ? (
                          <b key={i} className="pal-hl">
                            {run.text}
                          </b>
                        ) : (
                          <span key={i}>{run.text}</span>
                        ),
                      )}
                    </span>
                    {row.sub && <span className="sub">{row.sub}</span>}
                    {row.tag && <span className="pal-tag">{row.tag}</span>}
                    {row.keys && (
                      <span className="pal-keys" aria-hidden>
                        {row.keys.map((key, i) => (
                          <kbd key={i}>{key}</kbd>
                        ))}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {rows.length === 0 && (
          <p className="palette-empty">
            {term.length < 2 ? t('palette.typeMore') : searching ? t('kbd.searching') : t('palette.noMatches')}
          </p>
        )}

        <p className="sr-only" role="status">
          {status}
        </p>

        <p className="palette-hint pal-hint">
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
