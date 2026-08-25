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

export async function POST(request: Request) {
  if (!(await requireGlobal())) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  const body = (await request.json()) as {
    type?: string;
    name?: string;
    config?: Record<string, string>;
    events?: string[];
  };
  if (!body.type || !VALID_TYPES.includes(body.type as ChannelType)) {
    return NextResponse.json({ error: 'Invalid channel type' }, { status: 400 });
  }
  const channel = await createChannel({
    type: body.type,
    name: body.name?.trim() || body.type,
    config: body.config ?? {},
    events: sanitizeEvents(body.events),
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
    enabled?: boolean;
  };
  if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  await updateChannel(body.id, {
    name: body.name?.trim() || undefined,
    config: body.config,
    events: body.events ? sanitizeEvents(body.events) : undefined,
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
