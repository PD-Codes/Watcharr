import type { Metadata, Viewport } from 'next';
import { Archivo, Inter_Tight, JetBrains_Mono } from 'next/font/google';
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-US" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
