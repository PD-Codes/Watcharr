'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './Icons';
import { applyTheme, currentTheme, revealTransition } from './ThemeToggle';
import { setRail } from './useRail';
import { trapTab, useDialog } from './overlay';
import {
  COMMAND_EVENT,
  GO_TO,
  OPEN_SEARCH_EVENT,
  PENDING_MS,
  isEditableTarget,
  stepKey,
  type Command,
} from './shortcuts-core';
import { useT } from '@/i18n/client';
import type { TranslationKey } from '@/i18n';
import './shortcuts.css';

export const CINEMA_KEY = 'watcharr-cinema';
const EXIT_FADE_MS = 3000;
const DIALOG_OPEN = '[role="dialog"][aria-modal="true"], dialog[open]';

// Cinema lives on <html data-cinema="1"> like the sidebar rail, so shortcuts.css can key
// everything off it and React only mirrors it.
function subscribeCinema(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-cinema'] });
  return () => observer.disconnect();
}
const readCinema = () => document.documentElement.dataset.cinema === '1';

// Same reason as the theme: the reveal applies a frame late, so a quick second "c" must
// toggle relative to where the first one is headed.
let heading: boolean | null = null;

function stamp(on: boolean) {
  if (on) document.documentElement.dataset.cinema = '1';
  else delete document.documentElement.dataset.cinema;
}

function setCinema(on: boolean) {
  try {
    if (on) sessionStorage.setItem(CINEMA_KEY, '1');
    else sessionStorage.removeItem(CINEMA_KEY);
  } catch {
    // Storage blocked: cinema mode just does not survive a reload.
  }
  heading = on;
  revealTransition(() => {
    stamp(on);
    if (heading === on) heading = null;
  });
}

// Destination -> label. The nav labels already exist; the two new routes get their own.
const GO_LABEL: Record<string, TranslationKey> = {
  '/': 'nav.overview',
  '/sessions': 'nav.sessions',
  '/watchlist': 'nav.watchlist',
  '/history': 'nav.history',
  '/activity': 'nav.activity',
  '/stats': 'nav.stats',
  '/libraries': 'nav.libraries',
  '/suggestions': 'nav.suggestions',
  '/wrapped': 'nav.wrapped',
  '/notifications': 'nav.notifications',
  '/profile': 'nav.profile',
  '/pick': 'kbd.actPick',
  '/screen': 'kbd.goScreen',
};

/**
 * Global keyboard shortcuts, the help overlay and cinema mode. Mount once in the app
 * layout, next to <CommandPalette />, which owns Cmd/Ctrl+K and the search itself.
 */
export default function Shortcuts() {
  const t = useT();
  const router = useRouter();
  const cinema = useSyncExternalStore(subscribeCinema, readCinema, () => false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [awake, setAwake] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  const pendingRef = useRef(false);
  const pendingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const exitRef = useRef<HTMLButtonElement>(null);

  const setWaiting = useCallback((on: boolean, restart = false) => {
    pendingRef.current = on;
    setPending(on);
    if (!on || restart) clearTimeout(pendingTimer.current);
    if (on && restart) {
      pendingTimer.current = setTimeout(() => {
        pendingRef.current = false;
        setPending(false);
      }, PENDING_MS);
    }
  }, []);

  const run = useCallback(
    (command: Command) => {
      switch (command) {
        case 'search':
          window.dispatchEvent(new Event(OPEN_SEARCH_EVENT));
          break;
        case 'help':
          setHelpOpen((open) => !open);
          break;
        case 'theme': {
          const next = currentTheme() === 'light' ? 'dark' : 'light';
          applyTheme(next);
          setAnnouncement(t(next === 'light' ? 'kbd.saidLight' : 'kbd.saidDark'));
          break;
        }
        case 'rail': {
          // Below 881px there is no sidebar to collapse.
          if (!matchMedia('(min-width: 881px)').matches) break;
          const on = document.documentElement.dataset.rail !== '1';
          setRail(on);
          setAnnouncement(t(on ? 'kbd.saidRailOn' : 'kbd.saidRailOff'));
          break;
        }
        case 'cinema': {
          const on = !(heading ?? readCinema());
          setCinema(on);
          setAnnouncement(t(on ? 'kbd.saidCinemaOn' : 'kbd.saidCinemaOff'));
          break;
        }
      }
    },
    [t],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // A dialog that handled the key (Esc in the palette) must not also leave cinema.
      if (event.defaultPrevented) return;
      if (isEditableTarget(event.target as HTMLElement | null) || document.querySelector(DIALOG_OPEN)) {
        setWaiting(false);
        return;
      }

      if (event.key === 'Escape') {
        if (heading ?? readCinema()) {
          event.preventDefault();
          run('cinema');
        }
        return;
      }

      const step = stepKey(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isComposing: event.isComposing,
          repeat: event.repeat,
          altGraph: event.getModifierState?.('AltGraph'),
        },
        pendingRef.current,
      );
      // A lone Shift press keeps the prefix waiting without restarting its clock.
      setWaiting(step.pending, step.pending && step.handled);
      if (step.handled) event.preventDefault();
      if (step.go) router.push(step.go);
      if (step.command) run(step.command);
    }

    // The palette asks for the commands it cannot run itself.
    function onCommand(event: Event) {
      run((event as CustomEvent<Command>).detail);
    }

    window.addEventListener('keydown', onKey);
    window.addEventListener(COMMAND_EVENT, onCommand);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(COMMAND_EVENT, onCommand);
      clearTimeout(pendingTimer.current);
    };
  }, [router, run, setWaiting]);

  // Restore cinema after a reload, drop it when the app shell goes away (sign-out).
  useEffect(() => {
    try {
      if (sessionStorage.getItem(CINEMA_KEY) === '1') stamp(true);
    } catch {
      // Storage blocked: start with the chrome.
    }
    return () => stamp(false);
  }, []);

  // The exit pill fades out after a quiet moment and comes back on any sign of life.
  useEffect(() => {
    if (!cinema) return;
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      setAwake(true);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.activeElement !== exitRef.current) setAwake(false);
      }, EXIT_FADE_MS);
    };
    wake();
    const events = ['pointermove', 'pointerdown', 'keydown', 'focusin'] as const;
    for (const name of events) window.addEventListener(name, wake, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, wake);
    };
  }, [cinema]);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      {pending && (
        <div className="sc-pending" role="status">
          <kbd>g</kbd>
          <span>{t('kbd.pending')}</span>
        </div>
      )}

      {cinema && (
        <button
          ref={exitRef}
          type="button"
          className="sc-exit"
          data-awake={awake ? '1' : '0'}
          onClick={() => run('cinema')}
        >
          <Icon name="close" />
          {t('kbd.exitCinema')}
          <kbd>esc</kbd>
        </button>
      )}

      {helpOpen && <Help onClose={() => setHelpOpen(false)} />}
    </>
  );
}

interface HelpRow {
  label: string;
  /** Alternatives; each is a list of keys joined by `joiner`. */
  keys: string[][];
  joiner?: 'then' | '+';
}

function Keys({ row }: { row: HelpRow }) {
  const t = useT();
  return (
    <dd>
      {row.keys.map((combo, i) => (
        <span className="sc-combo" key={i}>
          {i > 0 && <span className="sc-word">{t('kbd.or')}</span>}
          {combo.map((key, j) => (
            <span className="sc-combo" key={j}>
              {j > 0 && (row.joiner === 'then' ? <span className="sc-word">{t('kbd.then')}</span> : '+')}
              <kbd>{key}</kbd>
            </span>
          ))}
        </span>
      ))}
    </dd>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  useDialog(true, panel);

  const mod = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

  const groups = useMemo(() => {
    const general: HelpRow[] = [
      { label: t('kbd.sSearch'), keys: [['/'], [mod, 'K']], joiner: '+' },
      { label: t('kbd.actTheme'), keys: [['t']] },
      { label: t('kbd.sRail'), keys: [['[']] },
      { label: t('kbd.actCinemaOn'), keys: [['c']] },
      { label: t('kbd.sHelp'), keys: [['?']] },
      { label: t('kbd.sEsc'), keys: [['esc']] },
    ];
    const go: HelpRow[] = Object.entries(GO_TO).map(([key, href]) => ({
      label: t(GO_LABEL[href] ?? 'nav.overview'),
      keys: [['g', key]],
      joiner: 'then',
    }));
    const search: HelpRow[] = [
      { label: t('kbd.sMove'), keys: [['↑', '↓']], joiner: '+' },
      { label: t('kbd.sOpen'), keys: [['↵']] },
      { label: t('kbd.sEdges'), keys: [['home', 'end']], joiner: '+' },
      { label: t('kbd.close'), keys: [['esc']] },
    ];
    return [
      { id: 'general', title: t('kbd.groupGeneral'), rows: general },
      { id: 'go', title: t('kbd.groupGo'), rows: go },
      { id: 'search', title: t('kbd.groupSearch'), rows: search },
    ];
  }, [t, mod]);

  return (
    <div
      className="sc-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="sc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sc-help-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === '?') {
            event.preventDefault();
            onClose();
          } else if (panel.current) {
            trapTab(event, panel.current);
          }
        }}
      >
        <header className="sc-head">
          <h2 id="sc-help-title">{t('kbd.helpTitle')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('kbd.close')}>
            <Icon name="close" />
          </button>
        </header>
        <p className="sc-intro">{t('kbd.helpIntro')}</p>

        <div className="sc-cols">
          {groups.map((group) => (
            <section key={group.id} className={`sc-g-${group.id}`} aria-labelledby={`sc-group-${group.id}`}>
              <h3 id={`sc-group-${group.id}`}>{group.title}</h3>
              <dl>
                {group.rows.map((row) => (
                  <div className="sc-row" key={row.label + row.keys.join()}>
                    <dt>{row.label}</dt>
                    <Keys row={row} />
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
