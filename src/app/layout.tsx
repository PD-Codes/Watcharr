import type { Metadata, Viewport } from 'next';
import { Archivo, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import { dictionaryFor } from '@/i18n';
import { LocaleProvider } from '@/i18n/client';
import { getLocale } from '@/i18n/server';
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
 * Applies the stored scheme before the first paint. Doing this in an effect instead would
 * render one dark frame for a light-theme user on every navigation — the flash people
 * always notice. Kept to one statement and wrapped, because localStorage throws outright
 * in some embedded webviews.
 */
const THEME_BOOT = `try{var t=localStorage.getItem('watcharr-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolved here rather than in the app group so the login and setup screens, which sit
  // outside it, are translated too.
  const locale = await getLocale();

  return (
    <html lang={locale} className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <head>
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
