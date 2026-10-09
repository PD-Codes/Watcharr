import type { Translate } from '@/i18n';

// The markup of one newsletter issue, kept free of server-only imports so it can be tested
// on its own. Table-based and inline-styled on purpose: mail clients ignore most of a
// stylesheet, and the same HTML has to survive Gmail as well as the static page.

export interface MailCard {
  title: string;
  year?: number;
  kind: 'movie' | 'series';
  /** Episodes of this show that arrived in the period (0 when the server lists the series itself). */
  episodes: number;
  genres: string[];
  addedAt?: Date;
  poster?: string;
  backdrop?: string;
  rating?: number;
  runtimeMinutes?: number;
  tagline?: string;
  overview?: string;
  href?: string;
}

export interface MailPopular {
  title: string;
  plays: number;
  poster?: string;
  href?: string;
}

export interface MailModel {
  subject: string;
  intro: string;
  days: number;
  stats: { movies: number; series: number; episodes: number };
  topGenres: string[];
  hero?: MailCard;
  highlights: MailCard[];
  sections: { server: string; cards: MailCard[]; hidden: number }[];
  popular: MailPopular[];
  openUrl?: string;
}

const C = {
  bg: '#131211',
  card: '#1c1a18',
  line: '#2a2724',
  text: '#e9e6e1',
  muted: '#9b958c',
  faint: '#6f6a63',
  amber: '#ffb020',
};

/** Escapes text that goes into the HTML — titles and overviews come from outside. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const esc = escapeHtml;

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6))}…`;
}

export function formatRuntime(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

function metaLine(card: MailCard, t: Translate): string {
  const parts = [
    card.rating ? `<span style="color:${C.amber}">★ ${card.rating.toFixed(1)}</span>` : '',
    card.runtimeMinutes ? esc(formatRuntime(card.runtimeMinutes)) : '',
    esc(card.kind === 'movie' ? t('newsletterMail.movie') : t('newsletterMail.series')),
    card.episodes > 1 ? esc(t('newsletterMail.episodes', { count: card.episodes })) : '',
  ].filter(Boolean);
  return parts.join(` <span style="color:${C.faint}">·</span> `);
}

function chips(genres: string[]): string {
  return genres
    .slice(0, 4)
    .map(
      (g) =>
        `<span style="display:inline-block;margin:0 4px 4px 0;padding:2px 8px;border:1px solid ${C.line};border-radius:999px;font-size:11px;color:${C.muted}">${esc(g)}</span>`,
    )
    .join('');
}

const titleOf = (card: MailCard) => `${esc(card.title)}${card.year ? ` <span style="color:${C.muted};font-weight:400">(${card.year})</span>` : ''}`;

function link(href: string | undefined, inner: string, style = ''): string {
  return href
    ? `<a href="${esc(href)}" style="color:inherit;text-decoration:none;${style}">${inner}</a>`
    : inner;
}

function hero(card: MailCard, t: Translate): string {
  const image = card.backdrop ?? card.poster;
  const wide = Boolean(card.backdrop);
  return `
    <tr><td style="padding:22px 0 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border-radius:14px;overflow:hidden">
        ${
          image
            ? `<tr><td>${link(card.href, `<img src="${esc(image)}" alt="" width="640" style="display:block;width:100%;height:auto;${wide ? '' : 'max-height:360px;object-fit:cover'}">`)}</td></tr>`
            : ''
        }
        <tr><td style="padding:16px 18px 18px">
          <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${C.amber}">${esc(t('newsletterMail.pick'))}</div>
          <div style="font-size:22px;font-weight:700;color:${C.text};margin:6px 0 4px">${link(card.href, titleOf(card))}</div>
          <div style="font-size:12px;color:${C.muted};margin-bottom:8px">${metaLine(card, t)}</div>
          ${card.tagline ? `<div style="font-size:13px;font-style:italic;color:${C.muted};margin-bottom:8px">“${esc(card.tagline)}”</div>` : ''}
          ${card.overview ? `<div style="font-size:13px;line-height:1.5;color:${C.text};margin-bottom:10px">${esc(truncate(card.overview, 360))}</div>` : ''}
          <div>${chips(card.genres)}</div>
        </td></tr>
      </table>
    </td></tr>`;
}

function highlight(card: MailCard, t: Translate, locale: string): string {
  const added = card.addedAt
    ? t('newsletterMail.added', { date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(card.addedAt) })
    : '';
  return `
    <tr><td style="padding:0 0 10px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border-radius:12px;overflow:hidden">
        <tr>
          <td width="104" style="vertical-align:top;width:104px">${
            card.poster ? link(card.href, `<img src="${esc(card.poster)}" alt="" width="104" style="display:block;width:104px;height:auto">`) : ''
          }</td>
          <td style="vertical-align:top;padding:12px 14px">
            <div style="font-size:15px;font-weight:600;color:${C.text}">${link(card.href, titleOf(card))}</div>
            <div style="font-size:12px;color:${C.muted};margin:3px 0 6px">${metaLine(card, t)}${added ? ` <span style="color:${C.faint}">·</span> ${esc(added)}` : ''}</div>
            ${card.overview ? `<div style="font-size:12px;line-height:1.45;color:${C.text};opacity:.85;margin-bottom:6px">${esc(truncate(card.overview, 170))}</div>` : ''}
            <div>${chips(card.genres.slice(0, 3))}</div>
          </td>
        </tr>
      </table>
    </td></tr>`;
}

function tile(card: MailCard): string {
  return `
    <td width="25%" style="padding:0 5px 12px;vertical-align:top;width:25%">
      ${
        card.poster
          ? link(card.href, `<img src="${esc(card.poster)}" alt="" width="140" style="display:block;width:100%;max-width:140px;height:auto;border-radius:8px">`)
          : `<div style="height:100px;border-radius:8px;background:${C.card}"></div>`
      }
      <div style="margin-top:6px;font-size:12px;line-height:1.3;color:${C.text}">${link(card.href, esc(card.title))}</div>
      <div style="font-size:11px;color:${C.muted}">${card.year ?? ''}</div>
    </td>`;
}

function grid(cards: MailCard[]): string {
  const rows: string[] = [];
  for (let i = 0; i < cards.length; i += 4) {
    const row = cards.slice(i, i + 4).map(tile);
    // A short last row keeps its tiles at column width instead of stretching them.
    while (row.length < 4) row.push('<td width="25%" style="width:25%"></td>');
    rows.push(`<tr>${row.join('')}</tr>`);
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed">${rows.join('')}</table>`;
}

function heading(text: string): string {
  return `<tr><td style="padding:26px 0 10px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.muted}">${esc(text)}</td></tr>`;
}

function stat(value: number, label: string): string {
  return `<td align="center" style="padding:12px 2px;border-right:1px solid ${C.line}">
    <div style="font-size:24px;font-weight:700;color:${C.amber}">${value}</div>
    <div style="font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:${C.muted}">${esc(label)}</div></td>`;
}

export function buildNewsletterHtml(model: MailModel, t: Translate, locale: string): string {
  const { stats } = model;
  const empty = !model.hero && !model.highlights.length && !model.sections.length;
  const preheader = empty
    ? t('newsletterMail.nothing')
    : t('newsletterMail.preheader', { movies: stats.movies, series: stats.series });

  const statCells = [
    stat(stats.movies, t('newsletterMail.stat.movies')),
    stat(stats.series, t('newsletterMail.stat.series')),
    stats.episodes > 0 ? stat(stats.episodes, t('newsletterMail.stat.episodes')) : '',
  ].join('');

  const body = empty
    ? `<tr><td style="padding-top:20px;color:${C.muted};font-size:13px">${esc(t('newsletterMail.nothing'))}</td></tr>`
    : `
    <tr><td style="padding-top:18px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border-radius:12px;table-layout:fixed"><tr>${statCells}</tr></table>
      ${model.topGenres.length ? `<div style="margin-top:10px;font-size:12px;color:${C.muted}">${esc(t('newsletterMail.topGenres', { genres: model.topGenres.join(', ') }))}</div>` : ''}
    </td></tr>
    ${model.hero ? hero(model.hero, t) : ''}
    ${model.highlights.length ? heading(t('newsletterMail.highlights')) + model.highlights.map((c) => highlight(c, t, locale)).join('') : ''}
    ${
      model.popular.length
        ? heading(t('newsletterMail.mostWatched')) +
          `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border-radius:12px">${model.popular
            .map(
              (p, i) => `<tr>
                <td width="30" style="padding:8px 0 8px 14px;font-size:16px;font-weight:700;color:${C.amber}">${i + 1}</td>
                <td width="40" style="padding:8px 8px">${p.poster ? `<img src="${esc(p.poster)}" alt="" width="32" style="display:block;border-radius:4px">` : ''}</td>
                <td style="padding:8px 0;font-size:13px;color:${C.text}">${link(p.href, esc(p.title))}</td>
                <td align="right" style="padding:8px 14px;font-size:12px;color:${C.muted};white-space:nowrap">${esc(t('newsletterMail.plays', { count: p.plays }))}</td></tr>`,
            )
            .join('')}</table></td></tr>`
        : ''
    }
    ${model.sections
      .map(
        (s) =>
          heading(t('newsletterMail.more', { server: s.server })) +
          `<tr><td>${grid(s.cards)}${s.hidden > 0 ? `<div style="font-size:12px;color:${C.muted};padding:2px 5px 0">${esc(t('newsletterMail.andMore', { count: s.hidden }))}</div>` : ''}</td></tr>`,
      )
      .join('')}`;

  return `<!doctype html>
<html lang="${esc(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"></head>
<body style="margin:0;padding:24px 12px;background:${C.bg};font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg}">${esc(preheader)}</div>
  <table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto">
    <tr><td style="border-bottom:2px solid ${C.amber};padding-bottom:12px">
      <div style="font-size:24px;font-weight:700;color:${C.amber}">${esc(model.subject)}</div>
      <div style="font-size:12px;color:${C.muted};margin-top:4px">${esc(t('newsletterMail.period', { days: model.days }))}</div>
    </td></tr>
    ${model.intro ? `<tr><td style="padding-top:16px;font-size:14px;line-height:1.5;color:${C.text}">${esc(model.intro).replace(/\n/g, '<br>')}</td></tr>` : ''}
    ${body}
    ${
      model.openUrl
        ? `<tr><td align="center" style="padding:28px 0 4px"><a href="${esc(model.openUrl)}" style="display:inline-block;padding:11px 26px;border-radius:999px;background:${C.amber};color:#1a1200;font-size:14px;font-weight:700;text-decoration:none">${esc(t('newsletterMail.open'))}</a></td></tr>`
        : ''
    }
    <tr><td style="padding-top:28px;font-size:11px;line-height:1.5;color:${C.faint}">${esc(t('newsletterMail.footer'))}</td></tr>
  </table>
</body></html>`;
}
