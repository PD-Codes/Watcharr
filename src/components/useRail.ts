'use client';

import { useSyncExternalStore } from 'react';

export const RAIL_KEY = 'watcharr-rail';

// The collapsed state lives on <html data-rail="1"> so the boot script can set it before
// first paint. React only mirrors it, which means no flash of a wide sidebar on reload.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-rail'] });
  return () => observer.disconnect();
}

/** True while the sidebar is collapsed to its icon rail. */
export function useRail(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.rail === '1',
    () => false,
  );
}

export function setRail(on: boolean) {
  if (on) document.documentElement.dataset.rail = '1';
  else delete document.documentElement.dataset.rail;
  try {
    localStorage.setItem(RAIL_KEY, on ? '1' : '0');
  } catch {
    // Blocked storage: the choice lasts for this tab only.
  }
}
