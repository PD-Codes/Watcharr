'use client';

import { useEffect, type RefObject } from 'react';

// Shared plumbing for the modal overlays in this folder (palette, shortcut help).

// A counter, so two overlays open at once cannot unlock the page under each other.
let locks = 0;
let before = '';

/** Stops the page behind a modal from scrolling. Returns the matching unlock. */
export function lockScroll(): () => void {
  if (locks++ === 0) {
    before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  return () => {
    if (--locks === 0) document.body.style.overflow = before;
  };
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab inside `root`. Call from a keydown handler. */
export function trapTab(
  event: { key: string; shiftKey: boolean; preventDefault: () => void },
  root: HTMLElement,
) {
  if (event.key !== 'Tab') return;
  const stops = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0,
  );
  if (stops.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = stops[0];
  const last = stops[stops.length - 1];
  const active = document.activeElement;
  const outside = !active || !root.contains(active);
  if (event.shiftKey && (outside || active === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (outside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * While `open`: locks page scroll, moves focus to `initial`, and on close hands focus back
 * to whatever had it before. The hand-back only happens if focus fell to <body> with the
 * dialog, so focus that already moved to something else is left alone. An overlay that opens
 * another one (palette -> help) cannot be robbed either: the second one opens in a later task.
 */
export function useDialog(open: boolean, initial: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const unlock = lockScroll();
    initial.current?.focus();

    return () => {
      unlock();
      const now = document.activeElement;
      if ((!now || now === document.body) && opener?.isConnected) opener.focus();
    };
  }, [open, initial]);
}
