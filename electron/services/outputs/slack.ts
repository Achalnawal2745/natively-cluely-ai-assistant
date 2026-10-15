// Slack: the notes as an editable mrkdwn draft, the draft as Block Kit blocks,
// and the post to an Incoming Webhook the user added. Pure apart from the post,
// whose fetch is injected.
//
// The draft the user edits is readable text. Slack's control characters (&, <,
// >) are escaped when it is sent, so meeting text can never turn into a link,
// a user mention or an @channel ping.

import { actionItemLine, inlineSpans, type NotesDocument } from './notesDocument';
import { ConnectionError, httpRequest, type FetchLike } from './httpRequest';

/** Slack's limits: a section's text, the header, and the blocks in one message. */
export const SLACK_SECTION_MAX = 3000;
export const SLACK_HEADER_MAX = 150;
export const SLACK_MAX_BLOCKS = 50;
export const SLACK_DRAFT_MAX = 40_000;

const WEBHOOK_RE = /^https:\/\/hooks\.slack(?:-gov)?\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_\-/]+$/;

export function isSlackWebhookUrl(url: unknown): url is string {
    return typeof url === 'string' && url.length <= 512 && WEBHOOK_RE.test(url.trim());
}

export function escapeSlackText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** **bold** → *bold*, *italic* / _italic_ → _italic_, `code` kept. */
export function toSlackInline(text: string): string {
    return inlineSpans(text)
        .map((s) => (s.code ? `\`${s.text}\`` : s.bold ? `*${s.text}*` : s.italic ? `_${s.text}_` : s.text))
        .join('');
}

/** The draft shown in the composer. Plain mrkdwn, not yet escaped. */
export function composeSlackDraft(doc: NotesDocument, opts: { includeActionItems: boolean }): string {
    const out: string[] = [];
    for (const s of doc.sections) {
        const lines = [`*${s.heading}*`];
        if (s.paragraph) lines.push(toSlackInline(s.paragraph));
        for (const b of s.bullets) lines.push(`• ${toSlackInline(b)}`);
        out.push(lines.join('\n'));
    }
    if (opts.includeActionItems && doc.actionItems.length) {
        out.push(['*Action items*', ...doc.actionItems.map((a) => `${a.done ? '☑' : '☐'} ${toSlackInline(actionItemLine(a))}`)].join('\n'));
    }
    return out.join('\n\n');
}

/** Pieces of at most `max` characters, split on line breaks where possible. */
export function splitForSlack(text: string, max: number = SLACK_SECTION_MAX): string[] {
    const pieces: string[] = [];
    for (const para of text.split(/\n{2,}/)) {
        const p = para.trim();
        if (!p) continue;
        if (p.length <= max) { pieces.push(p); continue; }
        let current = '';
        for (const line of p.split('\n')) {
            const candidate = current ? `${current}\n${line}` : line;
            if (candidate.length <= max) { current = candidate; continue; }
            if (current) pieces.push(current);
            let rest = line;
            while (rest.length > max) {
                pieces.push(rest.slice(0, max));
                rest = rest.slice(max);
            }
            current = rest;
        }
        if (current) pieces.push(current);
    }
    return pieces;
}

export interface SlackPayload {
    text: string;
    blocks: Array<Record<string, unknown>>;
}

/** The message Slack receives: a header, the date line, the draft as sections. */
export function slackPayloadFromDraft(title: string, dateLabel: string, draft: string): SlackPayload {
    const safeDraft = escapeSlackText(draft.slice(0, SLACK_DRAFT_MAX));
    const header = title.length > SLACK_HEADER_MAX ? `${title.slice(0, SLACK_HEADER_MAX - 1)}…` : title;
    const blocks: Array<Record<string, unknown>> = [
        { type: 'header', text: { type: 'plain_text', text: header || 'Meeting notes', emoji: false } },
    ];
    if (dateLabel) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: escapeSlackText(dateLabel) }] });
    const room = SLACK_MAX_BLOCKS - blocks.length;
    const pieces = splitForSlack(safeDraft);
    const kept = pieces.slice(0, room);
    if (pieces.length > room && kept.length) {
        const last = kept[kept.length - 1];
        const note = '\n_(Shortened to fit one Slack message.)_';
        kept[kept.length - 1] = `${last.slice(0, SLACK_SECTION_MAX - note.length)}${note}`;
    }
    for (const piece of kept) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: piece } });
    // `text` is the notification and the fallback where blocks do not render.
    const fallback = `${escapeSlackText(title)}${dateLabel ? ` · ${escapeSlackText(dateLabel)}` : ''}`;
    return { text: fallback, blocks };
}

export async function postSlackWebhook(url: string, payload: SlackPayload, fetchImpl?: FetchLike, signal?: AbortSignal): Promise<void> {
    await httpRequest(url, { method: 'POST', json: payload, fetchImpl, signal, maxResponseBytes: 64 * 1024 });
}

/**
 * "Test connection" without posting anything to the channel: an empty message
 * is refused by a live webhook as a bad request (Slack answers "no_text"),
 * while a revoked or mistyped one is refused as forbidden, missing or gone.
 * So a bad-request answer proves the webhook is live.
 */
export async function testSlackWebhook(url: string, fetchImpl?: FetchLike, signal?: AbortSignal): Promise<void> {
    try {
        await httpRequest(url, { method: 'POST', json: {}, fetchImpl, signal, maxResponseBytes: 16 * 1024 });
    } catch (err) {
        if (err instanceof ConnectionError && err.status === 400) return;
        // Slack answers a revoked webhook with "invalid_token" and a removed one with "no_service".
        if (err instanceof ConnectionError && (err.status === 403 || err.status === 404 || err.status === 410)) {
            throw new ConnectionError('not_found', 'webhook gone', err.status);
        }
        throw err;
    }
}
