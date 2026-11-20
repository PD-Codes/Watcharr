import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { CHANNEL_TYPES, NOTIFICATION_EVENTS, type ChannelType } from '@/server/features';
import { createChannel, deleteChannel, updateChannel } from '@/server/notifications';
import { getGlobalAdminSession } from '@/server/session';
import { apiError, badBody, globalAdminRequired } from '@/server/apierror';

export const dynamic = 'force-dynamic';

const VALID_TYPES = CHANNEL_TYPES.map((c) => c.type) as ChannelType[];
const VALID_EVENTS = NOTIFICATION_EVENTS.map((e) => e.key);

function sanitizeEvents(events: unknown): string[] {
  return Array.isArray(events)
    ? events.filter((e): e is string => typeof e === 'string' && VALID_EVENTS.includes(e as (typeof VALID_EVENTS)[number]))
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
  if (!(await getGlobalAdminSession())) return globalAdminRequired();
  const body = await readBody(request, {
    type: 'string',
    name: 'string',
    config: 'stringMap',
    events: 'strings',
    conditions: 'object',
    template: 'string',
  });
  if (!body) return badBody();
  if (!body.type || !VALID_TYPES.includes(body.type as ChannelType)) {
    return apiError(400, 'invalid-channel-type', 'err.invalidChannelType');
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
  if (!(await getGlobalAdminSession())) return globalAdminRequired();
  const body = await readBody(request, {
    id: 'number',
    name: 'string',
    config: 'stringMap',
    events: 'strings',
    conditions: 'object',
    template: 'string',
    enabled: 'boolean',
  });
  if (!body) return badBody();
  if (!body.id) return apiError(400, 'id-required', 'err.idRequired');

  const updated = await updateChannel(body.id, {
    name: body.name?.trim() || undefined,
    config: body.config ?? undefined,
    events: body.events ? sanitizeEvents(body.events) : undefined,
    conditions: body.conditions == null ? undefined : sanitizeConditions(body.conditions),
    template: body.template == null ? undefined : sanitizeTemplate(body.template),
    enabled: body.enabled ?? undefined,
  });
  // A new SMTP host with the old password left blank: the stored secret is not sent to an
  // address it was never entered for.
  if (!updated.ok) return apiError(400, 'invalid-channel', 'err.actionFailed', { message: updated.error });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!(await getGlobalAdminSession())) return globalAdminRequired();
  const body = await readBody(request, { id: 'number' });
  if (!body) return badBody();
  if (!body.id) return apiError(400, 'id-required', 'err.idRequired');
  await deleteChannel(body.id);
  return NextResponse.json({ ok: true });
}
