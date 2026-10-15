// CRM notes: the meeting's notes as a note on each attendee the CRM knows,
// found by email. HubSpot (private app token), Attio (API key) and Affinity
// (API key). The user sees who matched before anything is written.
//
// TODO(salesforce): Salesforce is not built. Its REST API needs an OAuth
// connected app (a client id registered with Salesforce and a browser sign-in
// with a redirect back to Natively), which a pasted token cannot replace. Add
// it as a provider here once that app exists, with the same match-then-send
// shape: SOQL `SELECT Id, Name FROM Contact WHERE Email IN (...)`, then a
// ContentNote linked to each contact through ContentDocumentLink.

import type { CrmService } from '../../../src/types/meetingOutputs';
import { httpRequest, type FetchLike } from './httpRequest';
import { notesToMarkdown, notesToPlainText, type NotesDocument } from './notesDocument';

export const CRM_LABELS: Record<CrmService, string> = { hubspot: 'HubSpot', attio: 'Attio', affinity: 'Affinity' };

/** Attendees looked up per send; more are not worth a burst of requests. */
export const CRM_MAX_ATTENDEES = 25;
const NOTE_MAX_CHARS = 60_000;

export interface CrmRecord { id: string; name?: string }
export interface CrmMatch { email: string; name?: string; record?: CrmRecord }

interface CrmCallOpts { token: string; fetchImpl?: FetchLike; signal?: AbortSignal }

export function normaliseEmail(raw: unknown): string | null {
    const e = String(raw ?? '').trim().toLowerCase();
    return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(e) ? e : null;
}

/**
 * The attendees worth looking up: valid, distinct emails, minus the user's own
 * addresses and calendar resources (rooms), at most CRM_MAX_ATTENDEES.
 */
export function crmCandidates(attendees: Array<{ email: string; name?: string }>, selfEmails: string[] = []): Array<{ email: string; name?: string }> {
    const self = new Set(selfEmails.map(normaliseEmail).filter(Boolean) as string[]);
    const seen = new Set<string>();
    const out: Array<{ email: string; name?: string }> = [];
    for (const a of attendees) {
        const email = normaliseEmail(a?.email);
        if (!email || self.has(email) || seen.has(email)) continue;
        if (/@resource\.calendar\.google\.com$/.test(email) || /@group\.calendar\.google\.com$/.test(email)) continue;
        seen.add(email);
        out.push({ email, ...(a.name ? { name: a.name } : {}) });
        if (out.length >= CRM_MAX_ATTENDEES) break;
    }
    return out;
}

// ── Lookups: one record per email, matched case-insensitively ─────────────

/** HubSpot contact search: the first contact whose email is exactly this one. */
export function parseHubspotContacts(data: any, email: string): CrmRecord | undefined {
    for (const r of Array.isArray(data?.results) ? data.results : []) {
        const p = r?.properties || {};
        if (String(p.email || '').toLowerCase() !== email) continue;
        const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
        return { id: String(r.id), ...(name ? { name } : {}) };
    }
    return undefined;
}

export function parseAttioPeople(data: any, email: string): CrmRecord | undefined {
    for (const r of Array.isArray(data?.data) ? data.data : []) {
        const emails: string[] = (r?.values?.email_addresses || []).map((e: any) => String(e?.email_address || '').toLowerCase());
        if (!emails.includes(email)) continue;
        const id = r?.id?.record_id;
        if (typeof id !== 'string') continue;
        const name = String(r?.values?.name?.[0]?.full_name || '').trim();
        return { id, ...(name ? { name } : {}) };
    }
    return undefined;
}

export function parseAffinityPersons(data: any, email: string): CrmRecord | undefined {
    for (const p of Array.isArray(data?.persons) ? data.persons : []) {
        const emails: string[] = [p?.primary_email, ...(Array.isArray(p?.emails) ? p.emails : [])].map((e) => String(e || '').toLowerCase());
        if (!emails.includes(email)) continue;
        if (p?.id === undefined || p?.id === null) continue;
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
        return { id: String(p.id), ...(name ? { name } : {}) };
    }
    return undefined;
}

const HUBSPOT = 'https://api.hubapi.com';
const ATTIO = 'https://api.attio.com/v2';
const AFFINITY = 'https://api.affinity.co';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
/** Affinity uses HTTP Basic with an empty user name and the key as the password. */
const affinityAuth = (token: string) => ({ Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}` });

export async function findCrmRecord(service: CrmService, email: string, o: CrmCallOpts): Promise<CrmRecord | undefined> {
    if (service === 'hubspot') {
        const res = await httpRequest(`${HUBSPOT}/crm/v3/objects/contacts/search`, {
            method: 'POST',
            headers: bearer(o.token),
            json: { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], properties: ['email', 'firstname', 'lastname'], limit: 5 },
            fetchImpl: o.fetchImpl, signal: o.signal,
        });
        return parseHubspotContacts(res.data, email);
    }
    if (service === 'attio') {
        const res = await httpRequest(`${ATTIO}/objects/people/records/query`, {
            method: 'POST',
            headers: bearer(o.token),
            json: { filter: { email_addresses: email }, limit: 5 },
            fetchImpl: o.fetchImpl, signal: o.signal,
        });
        return parseAttioPeople(res.data, email);
    }
    const res = await httpRequest(`${AFFINITY}/persons?term=${encodeURIComponent(email)}&page_size=10`, {
        headers: affinityAuth(o.token), fetchImpl: o.fetchImpl, signal: o.signal,
    });
    return parseAffinityPersons(res.data, email);
}

/** Each candidate with the CRM record its email belongs to, if any. Sequential, to stay under rate limits. */
export async function matchAttendees(service: CrmService, candidates: Array<{ email: string; name?: string }>, o: CrmCallOpts): Promise<CrmMatch[]> {
    const out: CrmMatch[] = [];
    for (const c of candidates) {
        const record = await findCrmRecord(service, c.email, o);
        out.push({ ...c, ...(record ? { record } : {}) });
    }
    return out;
}

export async function testCrm(service: CrmService, o: CrmCallOpts): Promise<void> {
    if (service === 'hubspot') {
        await httpRequest(`${HUBSPOT}/crm/v3/objects/contacts?limit=1`, { headers: bearer(o.token), fetchImpl: o.fetchImpl, signal: o.signal });
    } else if (service === 'attio') {
        await httpRequest(`${ATTIO}/self`, { headers: bearer(o.token), fetchImpl: o.fetchImpl, signal: o.signal });
    } else {
        await httpRequest(`${AFFINITY}/auth/whoami`, { headers: affinityAuth(o.token), fetchImpl: o.fetchImpl, signal: o.signal });
    }
}

// ── Writing the note ─────────────────────────────────────────────────────

function htmlParagraphs(text: string): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/** The note bodies, per CRM: HubSpot takes HTML, Attio Markdown, Affinity plain text. */
export function crmNoteBody(service: CrmService, doc: NotesDocument): string {
    if (service === 'attio') return notesToMarkdown(doc, { includeTitle: false }).slice(0, NOTE_MAX_CHARS);
    const text = notesToPlainText(doc).slice(0, NOTE_MAX_CHARS);
    return service === 'hubspot' ? htmlParagraphs(text) : text;
}

/** HubSpot's own association type for note → contact. */
export const HUBSPOT_NOTE_TO_CONTACT = 202;

/** Writes the note and returns how many notes were created. */
export async function sendCrmNote(service: CrmService, doc: NotesDocument, records: CrmRecord[], o: CrmCallOpts): Promise<number> {
    if (!records.length) return 0;
    const body = crmNoteBody(service, doc);
    if (service === 'hubspot') {
        // One note associated with every matched contact, as HubSpot shows a call note.
        await httpRequest(`${HUBSPOT}/crm/v3/objects/notes`, {
            method: 'POST',
            headers: bearer(o.token),
            json: {
                properties: { hs_timestamp: Number.isNaN(Date.parse(doc.dateIso)) ? new Date().toISOString() : new Date(doc.dateIso).toISOString(), hs_note_body: body },
                associations: records.map((r) => ({
                    to: { id: r.id },
                    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: HUBSPOT_NOTE_TO_CONTACT }],
                })),
            },
            fetchImpl: o.fetchImpl, signal: o.signal,
        });
        return 1;
    }
    if (service === 'affinity') {
        const ids = records.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
        await httpRequest(`${AFFINITY}/notes`, {
            method: 'POST',
            headers: affinityAuth(o.token),
            json: { person_ids: ids, content: `${doc.title}\n\n${body}`.slice(0, NOTE_MAX_CHARS) },
            fetchImpl: o.fetchImpl, signal: o.signal,
        });
        return 1;
    }
    // Attio notes belong to one record each.
    let created = 0;
    for (const r of records) {
        await httpRequest(`${ATTIO}/notes`, {
            method: 'POST',
            headers: bearer(o.token),
            json: { data: { parent_object: 'people', parent_record_id: r.id, title: doc.title.slice(0, 250), format: 'markdown', content: body } },
            fetchImpl: o.fetchImpl, signal: o.signal,
        });
        created += 1;
    }
    return created;
}
