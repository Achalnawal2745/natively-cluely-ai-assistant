// assistNotes.ts
//
// The saved meetings the assist features read, and what they read out of the
// notes: action items (with owner, deadline and status), decisions and open
// questions. Reads the V3 notes and the older V2 shape, like
// recurringMeetings.readPreviousNotes, but keeps every field the assist lists
// need (the status, so a ticked item never comes back).
//
// Pure, no I/O, no platform branches.

import type { CalendarEventSnapshot } from '../calendar/calendarSessionMatch';

/** One saved meeting as the assist features need it (DatabaseManager.getMeetingsWithNotesSince). */
export interface AssistMeeting {
  id: string;
  title?: string;
  startMs: number;
  durationMs?: number;
  calendarEventId?: string | null;
  calendarEvent?: Partial<CalendarEventSnapshot> | null;
  detailedSummary?: any;
  summaryStatus?: string | null;
  isProcessed?: boolean;
}

export interface NoteAction {
  text: string;
  owner?: string;
  deadline?: string;
  done: boolean;
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** True when the meeting's notes are written (not processing, not failed). */
export function notesReady(m: AssistMeeting): boolean {
  if (m.isProcessed === false) return false;
  if (m.summaryStatus && m.summaryStatus !== 'completed') return false;
  return !!m.detailedSummary && typeof m.detailedSummary === 'object';
}

/** Action items from the notes, newest shape first (V3, then structured V2, then plain strings). */
export function readActions(detailed: any): NoteAction[] {
  const d = detailed && typeof detailed === 'object' ? detailed : {};
  const source: any[] = Array.isArray(d.actionItemsV3) && d.actionItemsV3.length
    ? d.actionItemsV3
    : Array.isArray(d.actionItemsStructured) && d.actionItemsStructured.length
      ? d.actionItemsStructured
      : Array.isArray(d.actionItems) ? d.actionItems : [];
  const out: NoteAction[] = [];
  for (const a of source) {
    if (typeof a === 'string') {
      const text = clean(a);
      if (text) out.push({ text, done: false });
      continue;
    }
    if (!a || typeof a !== 'object') continue;
    const text = clean(a.text);
    if (!text) continue;
    const done = a.status === 'done' || a.completed === true || a.done === true;
    out.push({
      text,
      ...(clean(a.owner) ? { owner: clean(a.owner) } : {}),
      ...(clean(a.deadline) ? { deadline: clean(a.deadline) } : {}),
      done,
    });
  }
  return out;
}

export function readDecisions(detailed: any): string[] {
  const d = detailed && typeof detailed === 'object' ? detailed : {};
  return (Array.isArray(d.decisions) ? d.decisions : [])
    .map((x: any) => clean(typeof x === 'string' ? x : x?.text))
    .filter(Boolean);
}

export function readOpenQuestions(detailed: any): string[] {
  const d = detailed && typeof detailed === 'object' ? detailed : {};
  return (Array.isArray(d.openQuestions) ? d.openQuestions : [])
    .filter((q: any) => !(q && typeof q === 'object' && q.status === 'answered'))
    .map((q: any) => clean(typeof q === 'string' ? q : q?.text))
    .filter(Boolean);
}

/** The title the notes gave the meeting, else the stored one. */
export function meetingTitle(m: AssistMeeting): string {
  const d = m.detailedSummary;
  const fromNotes = d && typeof d === 'object' ? clean(d.title) : '';
  if (fromNotes && !/^meeting notes$/i.test(fromNotes)) return fromNotes;
  return clean(m.title) || clean(m.calendarEvent?.title) || 'Meeting';
}

/** Addresses on the meeting's invite (attendees who did not decline, and the organizer), lower case. */
export function meetingEmails(m: AssistMeeting): Set<string> {
  const out = new Set<string>();
  const ev = m.calendarEvent;
  for (const a of Array.isArray(ev?.attendees) ? ev!.attendees : []) {
    if (a && typeof a.email === 'string' && a.email.includes('@') && a.response !== 'declined') out.add(a.email.toLowerCase());
  }
  const org = (ev as any)?.organizer;
  if (org && typeof org.email === 'string' && org.email.includes('@') && !org.self) out.add(org.email.toLowerCase());
  return out;
}

/** Text as two items compare: case, spaces and trailing punctuation ignored. */
export function normalizeItemText(text: string): string {
  return clean(text).toLowerCase().replace(/[.!?;:,]+$/, '').replace(/\s+/g, ' ');
}

/** Cut on a word boundary to `max` characters, ellipsis included. */
export function clip(text: string, max: number): string {
  const c = clean(text);
  if (c.length <= max) return c;
  const cut = c.slice(0, Math.max(1, max - 1));
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * When a deadline as the notes wrote it falls, as the end of that day (UTC),
 * read against the meeting it was set in. Understands ISO dates, "Oct 20" /
 * "20 October", weekdays ("Friday", "by Fri": the next one on or after the
 * meeting), "today", "tomorrow", "end of week" / "EOW", "next week", "end of
 * month". Null when it cannot tell (the item is then ordered by age).
 */
export function parseDeadline(deadline: string | undefined | null, meetingStartMs: number): number | null {
  const text = clean(deadline).toLowerCase().replace(/^(by|before|due|on|until)\s+/, '');
  if (!text || !Number.isFinite(meetingStartMs)) return null;
  const base = utcDay(meetingStartMs);
  const endOf = (dayMs: number) => dayMs + DAY_MS - 1;

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const ms = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isFinite(ms) ? endOf(ms) : null;
  }
  if (/\b(today|eod|end of day|tonight)\b/.test(text)) return endOf(base);
  if (/\btomorrow\b/.test(text)) return endOf(base + DAY_MS);
  if (/\b(end of (the )?week|eow|this week)\b/.test(text)) {
    const dow = new Date(base).getUTCDay();
    return endOf(base + ((5 - dow + 7) % 7) * DAY_MS);
  }
  if (/\bnext week\b/.test(text)) {
    const dow = new Date(base).getUTCDay();
    return endOf(base + (((5 - dow + 7) % 7) + 7) * DAY_MS);
  }
  if (/\b(end of (the )?month|eom)\b/.test(text)) {
    const d = new Date(base);
    return endOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - DAY_MS);
  }
  // "Oct 20", "20 Oct", "October 20th"
  const monthDay = text.match(/\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/) || null;
  const dayMonth = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\b/) || null;
  const pick = monthDay && MONTHS.includes(monthDay[1])
    ? { month: MONTHS.indexOf(monthDay[1]), day: Number(monthDay[2]) }
    : dayMonth && MONTHS.includes(dayMonth[2])
      ? { month: MONTHS.indexOf(dayMonth[2]), day: Number(dayMonth[1]) }
      : null;
  if (pick && pick.day >= 1 && pick.day <= 31) {
    const year = new Date(base).getUTCFullYear();
    let ms = Date.UTC(year, pick.month, pick.day);
    // A date well before the meeting is next year's ("Jan 5" said in December).
    if (ms < base - 60 * DAY_MS) ms = Date.UTC(year + 1, pick.month, pick.day);
    return endOf(ms);
  }
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const full = WEEKDAYS[i];
    if (new RegExp(`\\b(${full}|${full.slice(0, 3)})\\b`).test(text)) {
      const dow = new Date(base).getUTCDay();
      const ahead = (i - dow + 7) % 7;
      const nextWeek = /\bnext\b/.test(text) ? 7 : 0;
      return endOf(base + (ahead + nextWeek) * DAY_MS);
    }
  }
  return null;
}

export { DAY_MS };
