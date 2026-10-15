// owedItems.ts
//
// "You owe": the open action items the user owns, across recent meetings.
//
// An item is the user's when its owner is the user ("Me", their name or first
// name, their address: assistPeople.ownerIsUser). Items the notes already mark
// done are left out, and so is anything the user ticked here (kept locally,
// AssistService). A ticked item comes back only when a LATER meeting raises it
// again, which is a new promise, not the old one.
//
// The same promise carried from meeting to meeting (a weekly sync) shows once:
// linked to the newest meeting that mentions it, aged from the first.
//
// Order: overdue first (the most overdue at the top), then those with a
// deadline (soonest first), then the rest, oldest first.
//
// Pure, no I/O, no platform branches.

import { ownerIsUser, type UserIdentity } from './assistPeople';
import { DAY_MS, meetingTitle, normalizeItemText, notesReady, parseDeadline, readActions, type AssistMeeting } from './assistNotes';

export interface OwedItem {
  /** Stable across meetings: the item's text, normalised. What "done" is stored under. */
  key: string;
  text: string;
  owner?: string;
  deadline?: string;
  /** End of the deadline's day, or null when the deadline is not a date Natively can read. */
  dueMs: number | null;
  overdue: boolean;
  /** The newest meeting that mentions it (where it is opened from). */
  meetingId: string;
  meetingTitle: string;
  meetingStartMs: number;
  /** When it was first raised. */
  sinceMs: number;
}

/** Ticked items: key -> when it was ticked. */
export type DoneMap = Record<string, number>;

export const OWED_LOOKBACK_DAYS = 30;
export const OWED_MAX_ITEMS = 50;

export function owedItemKey(text: string): string {
  return `owed:${normalizeItemText(text).slice(0, 200)}`;
}

export interface CollectOwedOptions {
  nowMs: number;
  done?: DoneMap;
  lookbackDays?: number;
  limit?: number;
  /** Only meetings whose invite includes one of these addresses (the brief: items involving these people). */
  withEmails?: Set<string>;
}

/** Sort as the list shows: overdue, then due soonest, then oldest. */
export function compareOwed(a: OwedItem, b: OwedItem): number {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  const ad = a.dueMs ?? Infinity;
  const bd = b.dueMs ?? Infinity;
  if (ad !== bd) return ad - bd;
  if (a.sinceMs !== b.sinceMs) return a.sinceMs - b.sinceMs;
  return a.text.localeCompare(b.text);
}

export function collectOwedItems(meetings: AssistMeeting[], identity: UserIdentity, opts: CollectOwedOptions): OwedItem[] {
  const lookbackMs = (opts.lookbackDays ?? OWED_LOOKBACK_DAYS) * DAY_MS;
  const done = opts.done ?? {};
  const byKey = new Map<string, OwedItem>();
  const ordered = [...meetings]
    .filter((m) => m && Number.isFinite(m.startMs) && m.startMs <= opts.nowMs && opts.nowMs - m.startMs <= lookbackMs && notesReady(m))
    .sort((a, b) => a.startMs - b.startMs);

  for (const m of ordered) {
    if (opts.withEmails && opts.withEmails.size > 0) {
      const emails = new Set((m.calendarEvent?.attendees ?? []).map((a) => String(a?.email ?? '').toLowerCase()));
      const org = (m.calendarEvent as any)?.organizer?.email;
      if (org) emails.add(String(org).toLowerCase());
      if (![...opts.withEmails].some((e) => emails.has(e))) continue;
    }
    for (const action of readActions(m.detailedSummary)) {
      if (!ownerIsUser(action.owner, identity)) continue;
      const key = owedItemKey(action.text);
      const existing = byKey.get(key);
      if (action.done) {
        // Marked done in a later meeting's notes: no longer owed.
        byKey.delete(key);
        continue;
      }
      const tickedAt = done[key];
      if (typeof tickedAt === 'number' && m.startMs <= tickedAt) continue;
      const dueMs = parseDeadline(action.deadline, m.startMs) ?? existing?.dueMs ?? null;
      byKey.set(key, {
        key,
        text: action.text,
        ...(action.owner ? { owner: action.owner } : {}),
        ...(action.deadline ? { deadline: action.deadline } : existing?.deadline ? { deadline: existing.deadline } : {}),
        dueMs,
        overdue: dueMs !== null && dueMs < opts.nowMs,
        meetingId: m.id,
        meetingTitle: meetingTitle(m),
        meetingStartMs: m.startMs,
        sinceMs: existing?.sinceMs ?? m.startMs,
      });
    }
  }
  return [...byKey.values()].sort(compareOwed).slice(0, opts.limit ?? OWED_MAX_ITEMS);
}

/** Drops ticks older than the lookback (nothing they could hide is still read). */
export function pruneDone(done: DoneMap, nowMs: number, lookbackDays: number = OWED_LOOKBACK_DAYS * 2): DoneMap {
  const out: DoneMap = {};
  for (const [k, v] of Object.entries(done || {})) {
    if (typeof v === 'number' && nowMs - v <= lookbackDays * DAY_MS) out[k] = v;
  }
  return out;
}
