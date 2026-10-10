import 'server-only';
import { getServerBySlug, listServers, type ServerRow } from './config';
import { isAdmin, type Session } from './session';
import type { Scope } from './stats';

export type ViewKind = 'me' | 'server';

export interface View {
  kind: ViewKind;
  scope: Scope;
  /** The server being looked at: the chosen one in the server view, otherwise the reader's own. */
  server: Pick<ServerRow, 'id' | 'label' | 'slug'>;
  /** Servers the reader may switch between; more than one only for a global admin. */
  servers: Pick<ServerRow, 'id' | 'label' | 'slug'>[];
  /** Whether the server view is open to this reader at all. */
  canServer: boolean;
}

/**
 * "Me" or "the whole server" for the pages that offer both (lobby display, year in review).
 *
 * The server view is an admin view, the same rule as the dashboard: it names people and shows
 * what everybody watched. A server admin sees their own server; a global admin picks any
 * (`?server=slug`, defaulting to their own). Anything the reader may not open falls back to
 * their personal view instead of an error, so a shared link never dead-ends.
 */
export async function resolveView(
  session: Session & { server: Pick<ServerRow, 'id' | 'label' | 'slug'> },
  params: { view?: string | string[]; server?: string | string[] },
  fallback: ViewKind = 'me',
): Promise<View> {
  const own = { id: session.server.id, label: session.server.label, slug: session.server.slug };
  const canServer = isAdmin(session.user);
  const wanted = (Array.isArray(params.view) ? params.view[0] : params.view) ?? fallback;
  const servers = session.user.globalAdmin
    ? (await listServers()).map(({ id, label, slug }) => ({ id, label, slug }))
    : [own];

  if (!canServer || wanted !== 'server') {
    return { kind: 'me', scope: { userId: session.user.id }, server: own, servers, canServer };
  }

  const slug = Array.isArray(params.server) ? params.server[0] : params.server;
  let server = own;
  if (slug && session.user.globalAdmin) {
    const picked = await getServerBySlug(slug);
    if (picked) server = { id: picked.id, label: picked.label, slug: picked.slug };
  }
  return { kind: 'server', scope: { userId: null, serverId: server.id }, server, servers, canServer };
}

/** Query string for a view link, keeping the other parameters a page passes in. */
export function viewQuery(view: { kind: ViewKind; server?: string }, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  if (view.kind === 'server') {
    params.set('view', 'server');
    if (view.server) params.set('server', view.server);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}
