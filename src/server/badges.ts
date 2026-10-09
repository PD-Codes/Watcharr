import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { customBadges } from '@/db/schema';
import { globalState } from '@/server/state';
import {
  MAX_CUSTOM_BADGES,
  validateCustomBadge,
  type CustomBadgeDef,
  type CustomFilter,
  type CustomMetric,
} from '@/server/insights-core';

// Bumped on every change; part of the insights memo key, so a new badge shows up at once
// instead of after the minute the computed shelves are kept.
const state = globalState('badges.version', () => ({ version: 0 }));
export const badgeVersion = () => state.version;

export async function listCustomBadges(): Promise<CustomBadgeDef[]> {
  const rows = await db.select().from(customBadges).orderBy(asc(customBadges.id));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    metric: row.metric as CustomMetric,
    filter: row.filter as CustomFilter,
    filterValue: row.filterValue,
    tiers: row.tiers,
  }));
}

/** Validates and stores one badge; the error text is meant for the admin's form. */
export async function createCustomBadge(
  input: Record<string, unknown>,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const checked = validateCustomBadge(input);
  if (!checked.ok) return checked;
  if ((await db.select({ id: customBadges.id }).from(customBadges)).length >= MAX_CUSTOM_BADGES) {
    return { ok: false, error: `At most ${MAX_CUSTOM_BADGES} custom badges` };
  }
  const [row] = await db.insert(customBadges).values(checked.value).returning({ id: customBadges.id });
  state.version += 1;
  return { ok: true, id: row.id };
}

/** Same checks as creating; the id stays, so nothing that points at the badge breaks. */
export async function updateCustomBadge(
  id: number,
  input: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const checked = validateCustomBadge(input);
  if (!checked.ok) return { ...checked, status: 400 };
  const changed = await db.update(customBadges).set(checked.value).where(eq(customBadges.id, id)).returning({ id: customBadges.id });
  if (changed.length === 0) return { ok: false, error: 'Unknown badge', status: 404 };
  state.version += 1;
  return { ok: true };
}

export async function deleteCustomBadge(id: number): Promise<boolean> {
  const removed = await db.delete(customBadges).where(eq(customBadges.id, id)).returning({ id: customBadges.id });
  state.version += 1;
  return removed.length > 0;
}
