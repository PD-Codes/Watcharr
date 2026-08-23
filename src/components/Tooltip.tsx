'use client';

import { useEffect, useState } from 'react';

interface Tip {
  text: string;
  x: number;
  y: number;
  below: boolean;
}

/**
 * One delegated tooltip for the whole app. A CSS ::after tooltip cannot work here:
 * pseudo elements do not render on SVG nodes, and a tooltip inside a scrolling or
 * clipping container gets cut off. This renders once at the document level, in fixed
 * coordinates, and flips below the target when there is no room above.
 */
export default function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const MARGIN = 10;

    function show(event: Event) {
      const target = (event.target as Element | null)?.closest?.('[data-tip]');
      if (!target) return;
      const text = target.getAttribute('data-tip');
      if (!text) return;

      const box = target.getBoundingClientRect();
      const below = box.top < 90;
      setTip({
        text,
        x: Math.min(Math.max(box.left + box.width / 2, 90), window.innerWidth - 90),
        y: below ? box.bottom + MARGIN : box.top - MARGIN,
        below,
      });
    }

    function hide(event: Event) {
      const target = (event.target as Element | null)?.closest?.('[data-tip]');
      if (!target) return;

      // Moving onto a child still counts as being inside the same element — without this
      // check the tooltip is cleared the moment the pointer enters a nested node.
      const next = (event as MouseEvent).relatedTarget as Node | null;
      if (next && target.contains(next)) return;

      setTip(null);
    }

    document.addEventListener('pointerover', show, true);
    document.addEventListener('pointerout', hide, true);
    document.addEventListener('focusin', show, true);
    document.addEventListener('focusout', hide, true);
    window.addEventListener('scroll', () => setTip(null), true);

    return () => {
      document.removeEventListener('pointerover', show, true);
      document.removeEventListener('pointerout', hide, true);
      document.removeEventListener('focusin', show, true);
      document.removeEventListener('focusout', hide, true);
    };
  }, []);

  if (!tip) return null;

  return (
    <div
      className="tip"
      role="tooltip"
      style={{
        left: tip.x,
        top: tip.y,
        transform: `translate(-50%, ${tip.below ? '0' : '-100%'})`,
      }}
    >
      {tip.text}
    </div>
  );
}
