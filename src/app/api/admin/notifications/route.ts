import { NextResponse } from 'next/server';
import { CHANNEL_TYPES, NOTIFICATION_EVENTS, type ChannelType } from '@/server/features';
import { createChannel, deleteChannel, updateChannel } from '@/server/notifications';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

async function requireGlobal() {
  const session = await getSession();
  return session?.user.globalAdmin ? session : null;
}

const VALID_TYPES = CHANNEL_TYPES.map((c) => c.type) as ChannelType[];
const VALID_EVENTS = NOTIFICATION_EVENTS.map((e) => e.key);

function sanitizeEvents(events: unknown): string[] {
  return Array.isArray(events)
    ? events.filter((e): e is string => typeof e === 'string' && VALID_EVENTS.includes(e as any))
    : [];
}

const MAX_TEMPLATE_LENGTH = 500;
const MAX_CONDITION_ENTRIES = 50;

/**
 * Only the keys the matcher understands, and only in the shape it expects. The column is
 * JSON, so an unfiltered body would put arbitrary structure into it — matchesConditions()
 * would ignore the rest, but the admin form would then render something it never wrote.
 */
function sanitizeConditions(input: unknown): Record<string, unknown> {
  const body = (input ?? {}) as Record<string, unknown>;
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          .map((v) => v.trim())
          .slice(0, MAX_CONDITION_ENTRIES)
      : [];

  const conditions: Record<string, unknown> = {};
  const users = strings(body.users);
  const mediaTypes = strings(body.mediaTypes);
  const libraries = strings(body.libraries);
  if (users.length) conditions.users = users;
  if (mediaTypes.length) conditions.mediaTypes = mediaTypes;
  // Not checked against the live section list: a library the media server no longer
  // reports would then be dropped from a channel the moment it is saved, and an admin
  // editing a name would find their filter quietly emptied.
  if (libraries.length) conditions.libraries = libraries;
  if (body.transcodeOnly === true) conditions.transcodeOnly = true;
  return conditions;
}

const sanitizeTemplate = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, MAX_TEMPLATE_LENGTH) : '';

export async function POST(request: Request) {
  if (!(await requireGlobal())) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  const body = (await request.json()) as {
    type?: string;
    name?: string;
    config?: Record<string, string>;
    events?: string[];
    conditions?: Record<string, unknown>;
    template?: string;
  };
  if (!body.type || !VALID_TYPES.includes(body.type as ChannelType)) {
    return NextResponse.json({ error: 'Invalid channel type' }, { status: 400 });
  }
  const channel = await createChannel({
    type: body.type,
    name: body.name?.trim() || body.type,
    config: body.config ?? {},
    events: sanitizeEvents(body.events),
    conditions: sanitizeConditions(body.conditions),
    template: sanitizeTemplate(body.template),
  });
  return NextResponse.json({ ok: true, id: channel.id });
}

export async function PATCH(request: Request) {
  if (!(await requireGlobal())) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  const body = (await request.json()) as {
    id?: number;
    name?: string;
    config?: Record<string, string>;
    events?: string[];
    conditions?: Record<string, unknown>;
    template?: string;
    enabled?: boolean;
  };
  if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  await updateChannel(body.id, {
    name: body.name?.trim() || undefined,
    config: body.config,
    events: body.events ? sanitizeEvents(body.events) : undefined,
    conditions: body.conditions === undefined ? undefined : sanitizeConditions(body.conditions),
    template: body.template === undefined ? undefined : sanitizeTemplate(body.template),
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!(await requireGlobal())) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  const { id } = (await request.json()) as { id?: number };
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  await deleteChannel(id);
  return NextResponse.json({ ok: true });
}
