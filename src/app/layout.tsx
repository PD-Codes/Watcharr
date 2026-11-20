import type { Metadata, Viewport } from 'next';
import { Archivo, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import { dictionaryFor } from '@/i18n';
import { LocaleProvider } from '@/i18n/client';
import { getLocale } from '@/i18n/server';
import { getRealSession } from '@/server/session';
import './globals.css';

// Fonts are downloaded at build time and served from the app itself, so a running
// deployment never talks to Google.
const display = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  variable: '--font-display',
  display: 'swap',
});

const body = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

// The locale comes from the session and the database, so nothing above this layout can be
// prerendered at build time.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Watcharr',
  description: 'Companion app for Plex, Jellyfin and Emby',
  applicationName: 'Watcharr',
  // Black keeps the iOS status bar from overlapping the page once it is on the home screen.
  appleWebApp: { capable: true, title: 'Watcharr', statusBarStyle: 'black' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Lets the page paint under the notch so env(safe-area-inset-*) has something to report,
  // which is what keeps the bottom navigation bar clear of the home indicator.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#08090b' },
    { media: '(prefers-color-scheme: light)', color: '#f6f6f4' },
  ],
};

/*
 * Applies the stored scheme and the collapsed-sidebar choice before the first paint. Doing
 * this in an effect instead would render one dark frame for a light-theme user on every
 * navigation — the flash people always notice. Wrapped, because localStorage throws
 * outright in some embedded webviews.
 *
 * A scheme the server already stamped (the signed-in user's choice from the database) wins
 * and is copied into localStorage, so the sign-in page after a logout keeps it too. Without
 * one, the browser's own memory applies, and failing that prefers-color-scheme in the CSS.
 */
const THEME_BOOT = `try{var d=document.documentElement,s=localStorage,k='watcharr-theme',t=d.dataset.theme;if(t)s.setItem(k,t);else{t=s.getItem(k);if(t)d.dataset.theme=t}if(s.getItem('watcharr-rail')==='1')d.dataset.rail='1'}catch(e){}`;

/**
 * The scheme stored for the person at the keyboard. The real session, not a "view as"
 * preview: an admin looking at someone else's pages is still sitting in front of their own
 * screen. Null for visitors and for "follow the system".
 */
async function storedTheme(): Promise<'dark' | 'light' | null> {
  const session = await getRealSession().catch(() => null);
  const theme = session?.user.theme;
  return theme === 'dark' || theme === 'light' ? theme : null;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolved here rather than in the app group so the login and setup screens, which sit
  // outside it, are translated too.
  const [locale, theme] = await Promise.all([getLocale(), storedTheme()]);

  return (
    <html
      lang={locale}
      className={`${display.variable} ${body.variable} ${mono.variable}`}
      data-theme={theme ?? undefined}
      // The boot script below may set data-theme (and data-rail) before React hydrates, so
      // the attributes differ from the server markup by design; without this the dev
      // console reports a hydration mismatch on every load.
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant from this file (THEME_BOOT), no outside input; it has to run before the first paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <LocaleProvider locale={locale} dictionary={dictionaryFor(locale)}>
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
