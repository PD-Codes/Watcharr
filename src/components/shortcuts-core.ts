// Key handling for the global shortcuts as a pure state machine, so the rules are testable
// without a browser. Shortcuts.tsx only feeds it events and carries out what it returns.

export type Command = 'search' | 'help' | 'theme' | 'rail' | 'cinema';

/** Anything can ask for the palette by firing this on window — no context provider needed. */
export const OPEN_SEARCH_EVENT = 'watcharr:search';

/** The palette asks Shortcuts to run a command by firing this on window with the command as detail. */
export const COMMAND_EVENT = 'watcharr:command';

/** How long "g" waits for its second key. */
export const PENDING_MS = 1200;

/** Second key after "g" -> destination. Letters are mnemonic where a free one exists. */
export const GO_TO: Readonly<Record<string, string>> = {
  h: '/',
  s: '/sessions',
  w: '/watchlist',
  y: '/history',
  a: '/activity',
  t: '/stats',
  l: '/libraries',
  u: '/suggestions',
  r: '/wrapped',
  n: '/notifications',
  m: '/profile',
  p: '/pick',
  c: '/screen',
};

/** The two keys that reach `href`, e.g. ['g', 's'], or null when it has no shortcut. */
export function goKeysFor(href: string): [string, string] | null {
  const key = Object.keys(GO_TO).find((k) => GO_TO[k] === href);
  return key ? ['g', key] : null;
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  /** getModifierState('AltGraph'): AltGr reports ctrl+alt on Windows but is just a layer key. */
  altGraph?: boolean;
}

export interface Step {
  /** Run this, if set. */
  command?: Command;
  /** Navigate here, if set. */
  go?: string;
  /** Is the "g" prefix waiting for its second key after this event? */
  pending: boolean;
  /** The event was a shortcut: the caller should preventDefault. */
  handled: boolean;
}

const MODIFIER_ONLY = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead']);

const SINGLE: Readonly<Record<string, Command>> = {
  '/': 'search',
  '?': 'help',
  t: 'theme',
  '[': 'rail',
  c: 'cinema',
};

/**
 * Cmd/Ctrl+K is deliberately absent: the palette owns it, so it keeps working even where
 * this component is not mounted.
 *
 * Symbols are matched on `key` and ignore Shift, because "/" and "?" need it on a German
 * layout. Letters need Shift to be off, so Shift+T is not "t". AltGr (which is how a German
 * keyboard types "[") must not count as Ctrl+Alt.
 */
export function stepKey(ev: KeyLike, pending: boolean): Step {
  const idle: Step = { pending: false, handled: false };
  if (ev.isComposing || ev.repeat) return { ...idle, pending };
  // Holding Shift to type "?" must not cancel a waiting "g".
  if (MODIFIER_ONLY.has(ev.key)) return { ...idle, pending };

  const gr = ev.altGraph === true;
  if ((ev.ctrlKey && !gr) || ev.metaKey) return idle;

  const isLetter = /^[a-z]$/i.test(ev.key);
  // Option+letter on a Mac types a different glyph and a browser shortcut on other systems.
  if (ev.altKey && !gr && (isLetter || /^\d$/.test(ev.key))) return idle;
  if (isLetter && ev.shiftKey) return idle;
  const key = isLetter ? ev.key.toLowerCase() : ev.key;

  if (pending) {
    const go = GO_TO[key];
    if (go) return { go, pending: false, handled: true };
    // Anything else cancels the prefix and is then read as an ordinary key ("g" "?" opens help).
  }

  if (key === 'g') return { pending: true, handled: true };
  const command = SINGLE[key];
  return command ? { command, pending: false, handled: true } : idle;
}

const NON_TEXT_INPUTS = new Set([
  'button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit',
]);

interface TargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

/** True where a key press is text for the field, not a shortcut. */
export function isEditableTarget(target: TargetLike | null | undefined): boolean {
  if (!target || typeof target.tagName !== 'string') return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') return !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase());
  return target.isContentEditable === true || target.getAttribute?.('contenteditable') === 'true';
}
