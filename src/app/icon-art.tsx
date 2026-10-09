/**
 * The brand mark behind the app icons: a projector bulb, lit, throwing a small cone of
 * light. No text, so the PNGs need no font and render the same everywhere.
 *
 * This is the one place the amber is a logo and not data: it is the bulb from the
 * wordmark. The graphite is the app's own (--surface-container-highest down to --ink),
 * spelled out as hex because an ImageResponse has no stylesheet to resolve tokens from.
 */

export type MarkVariant =
  /** Rounded square on transparent corners: the ordinary "any" icon. */
  | 'rounded'
  /** Full-bleed square, art kept inside the central safe zone: the maskable icon. */
  | 'maskable'
  /** Full-bleed square for iOS, which rounds the corners itself. */
  | 'square';

const SCALE: Record<MarkVariant, number> = { rounded: 1, maskable: 0.8, square: 0.92 };

export function BrandMark({ size, variant }: { size: number; variant: MarkVariant }) {
  const scale = SCALE[variant];
  return (
    <div style={{ display: 'flex', width: size, height: size }}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 100 100"
      >
        <defs>
          <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#242a35" />
            <stop offset="1" stopColor="#0c0e12" />
          </linearGradient>
          <radialGradient id="top" cx="0.3" cy="0" r="0.9">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.1" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#ffb020" stopOpacity="0.7" />
            <stop offset="0.4" stopColor="#ffb020" stopOpacity="0.26" />
            <stop offset="1" stopColor="#ffb020" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="cone" x1="0" y1="0.5" x2="1" y2="0.5">
            <stop offset="0" stopColor="#ffb020" stopOpacity="0.58" />
            <stop offset="1" stopColor="#ffb020" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="core" cx="0.38" cy="0.34" r="0.75">
            <stop offset="0" stopColor="#ffe6ad" />
            <stop offset="0.55" stopColor="#ffb020" />
            <stop offset="1" stopColor="#e08a00" />
          </radialGradient>
        </defs>

        <rect width="100" height="100" rx={variant === 'rounded' ? 22 : 0} fill="url(#plate)" />
        <rect width="100" height="100" rx={variant === 'rounded' ? 22 : 0} fill="url(#top)" />

        <g transform={`translate(50 50) scale(${scale}) translate(-50 -50)`}>
          <polygon points="36,50 88,21 88,79" fill="url(#cone)" />
          <circle cx="36" cy="50" r="30" fill="url(#halo)" />
          <circle cx="36" cy="50" r="9.5" fill="url(#core)" />
          <circle cx="33" cy="47" r="2.8" fill="#ffffff" fillOpacity="0.55" />
        </g>
      </svg>
    </div>
  );
}
