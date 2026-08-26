// Shared by every CSV export. It lives here rather than in one of the route files because
// a route.ts may only export the handler names Next knows — an extra export makes tsc fail
// against the generated route types. No 'server-only' import: this is pure string work.

function cell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /["\n,]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Header row plus data rows, joined. Values are stringified and quoted as needed. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(cell).join(','), ...rows.map((row) => row.map(cell).join(','))].join('\n');
}

/** A CSV download response, named so the browser saves it rather than rendering it. */
export function csvResponse(filename: string, body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
