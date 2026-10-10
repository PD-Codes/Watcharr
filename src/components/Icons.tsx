// Icons are inlined SVG rather than an icon font or package: the app must run with no
// outbound requests, and a font would ship a few hundred glyphs to render a dozen.
// All of them are 24×24, stroked, and inherit currentColor.

export type IconName =
  | 'overview'
  | 'watchlist'
  | 'history'
  | 'activity'
  | 'stats'
  | 'suggestions'
  | 'wrapped'
  | 'users'
  | 'server'
  | 'settings'
  | 'transcode'
  | 'devices'
  | 'menu'
  | 'close'
  | 'search'
  | 'sun'
  | 'moon'
  | 'external'
  | 'download'
  | 'back'
  | 'film'
  | 'tv'
  | 'bell'
  | 'panel'
  | 'dice'
  | 'monitor'
  | 'sparkles'
  | 'keyboard'
  | 'trophy'
  | 'share'
  | 'chevron'
  | 'logout'
  | 'music';

const PATHS: Record<IconName, React.ReactNode> = {
  film: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 12h18" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </>
  ),
  tv: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M8 21h8" />
    </>
  ),
  overview: <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />,
  watchlist: <path d="M6 4h12v16l-6-4-6 4z" />,
  history: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  activity: <path d="M9 6.5v11l9-5.5z" />,
  bell: (
    <>
      <path d="M6 10a6 6 0 1 1 12 0c0 3.5 1 4.8 1.8 5.6.4.4.1 1.1-.5 1.1H4.7c-.6 0-.9-.7-.5-1.1C5 14.8 6 13.5 6 10Z" />
      <path d="M10 19.5a2 2 0 0 0 4 0" />
    </>
  ),
  stats: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  suggestions: <path d="m12 3 2.2 5.3 5.8.5-4.4 3.8 1.3 5.7L12 15.3 7.1 18.3l1.3-5.7L4 8.8l5.8-.5z" />,
  wrapped: (
    <>
      <path d="M3 9h18v11H3zM3 9l2-4h14l2 4M12 5v15" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 5.5a3.2 3.2 0 0 1 0 6M18 20c0-2.4-.9-4-2.2-5" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4" />
    </>
  ),
  transcode: <path d="M4 8h11l-3-3m3 3-3 3M20 16H9l3-3m-3 3 3 3" />,
  devices: (
    <>
      <rect x="2" y="5" width="13" height="10" rx="1.5" />
      <rect x="16" y="9" width="6" height="10" rx="1.5" />
      <path d="M6 19h5" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.4-4.4" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5" />,
  external: <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  download: <path d="M12 4v10m0 0 4-4m-4 4-4-4M4 18h16" />,
  back: <path d="M15 5l-7 7 7 7" />,
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
    </>
  ),
  dice: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01" />
    </>
  ),
  monitor: (
    <>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3.5 13.7 9l5.8 1.7-5.8 1.7L12 18l-1.7-5.6L4.5 10.7 10.3 9z" />
      <path d="M19 3v3M17.5 4.5h3" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5v1.5A3 3 0 0 0 8 10.5M16 6h3.5v1.5a3 3 0 0 1-3.5 3M12 13v4M8.5 20h7M10 17h4" />
    </>
  ),
  share: <path d="M12 15V4m0 0L8 8m4-4 4 4M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  logout: <path d="M10 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M15 8l4 4-4 4M19 12H9" />,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
