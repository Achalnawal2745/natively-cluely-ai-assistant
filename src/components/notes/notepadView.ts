/*
  The notepad's own logic (NotesWindow.tsx, 2026-10-20), pure so it is tested
  without a DOM:

  - Ask's sources: the transcript lines an answer matches (shared words, no
    model call), shown under the answer as "In the transcript".
  - Ask's context: the last few questions and answers, sent with a new one.
  - The heading's people, grouped by company (the email's domain).
  - The enhanced notes after Stop, as copyable text.
  - The transcript panel's search.
  - The transcript panel's mic and language pickers (which choices to offer).
  - Ask's recipes: the first ones shown, the rest behind "All recipes".
*/

export interface TranscriptLine { speaker: string; text: string; at: number }

const STOP = new Set(('the a an and or but if then than that this these those there their they them you your yours we our ours i me my mine he she his her it its is are was were be been being '
    + 'have has had do does did done to of in on at by for with from as about into over after before up down out off so not no yes just also very can could would should will '
    + 'shall may might must what which who whom whose when where why how all any some each more most other such only own same too again once here both few many much '
    + 'like think know going yeah okay right really thing things well get got make made said say says want need one two').split(' '));

/** The words that carry meaning in a line: lower case, 3+ letters, no common words. */
export function contentWords(text: string): Set<string> {
    const out = new Set<string>();
    for (const raw of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) {
        const w = raw.replace(/'s$/, '').replace(/^-+|-+$/g, '');
        if (w.length < 3 || STOP.has(w)) continue;
        out.add(w);
    }
    return out;
}

/**
 * The transcript lines an answer draws on, best first then in time order: a
 * line shares at least `minShared` meaningful words with the answer, and at
 * least a third of its own. At most `max`. Lines under four meaningful words
 * never count (a "yes, that works" matches everything).
 */
export function answerSources(answer: string, lines: TranscriptLine[], max = 3, minShared = 3): TranscriptLine[] {
    const words = contentWords(answer);
    if (words.size === 0) return [];
    const scored: Array<{ line: TranscriptLine; score: number }> = [];
    for (const line of lines) {
        const own = contentWords(line.text);
        if (own.size < 4) continue;
        let shared = 0;
        for (const w of own) if (words.has(w)) shared++;
        if (shared >= minShared && shared / own.size >= 1 / 3) scored.push({ line, score: shared / own.size + shared / 100 });
    }
    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, max)
        .map((s) => s.line)
        .sort((a, b) => a.at - b.at);
}

export interface AskTurn { question: string; text: string; status: 'streaming' | 'done' | 'error' }

/** The last `max` finished turns as "User / Assistant" lines, for a follow-up question. */
export function askContext(turns: AskTurn[], max = 3): string | undefined {
    const done = turns.filter((t) => t.status === 'done' && t.text.trim()).slice(-max);
    if (done.length === 0) return undefined;
    return done.map((t) => `User: ${t.question}\nAssistant: ${t.text}`).join('\n\n');
}

export interface Attendee { email: string; name: string | null }

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com']);

/** "acme.io" → "Acme". Personal mail domains read "Personal". */
export function companyOfEmail(email: string): string {
    const domain = (email.split('@')[1] ?? '').toLowerCase();
    if (!domain) return 'Other';
    if (FREE_MAIL.has(domain)) return 'Personal';
    const parts = domain.split('.');
    const name = parts.length >= 3 && ['co', 'com', 'org', 'net', 'ac', 'gov'].includes(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2] ?? parts[0];
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Other';
}

/** The people grouped by company, the user's own company first, the user marked. */
export function groupAttendees(attendees: Attendee[], selfEmail: string | null): Array<{ company: string; people: Array<Attendee & { self: boolean }> }> {
    const self = selfEmail?.toLowerCase() ?? null;
    const selfCompany = self ? companyOfEmail(self) : null;
    const groups = new Map<string, Array<Attendee & { self: boolean }>>();
    for (const a of attendees) {
        const company = companyOfEmail(a.email);
        const list = groups.get(company) ?? [];
        list.push({ ...a, self: !!self && a.email.toLowerCase() === self });
        groups.set(company, list);
    }
    return [...groups.entries()]
        .sort(([a], [b]) => (a === selfCompany ? -1 : b === selfCompany ? 1 : a.localeCompare(b)))
        .map(([company, people]) => ({ company, people: people.sort((x, y) => Number(y.self) - Number(x.self)) }));
}

/** "10:00 – 10:30" from two ISO times, in the user's clock; '' when unreadable. */
export function eventTimeRange(start: string | null | undefined, end: string | null | undefined, locale?: string): string {
    const s = start ? Date.parse(start) : NaN;
    const e = end ? Date.parse(end) : NaN;
    if (!Number.isFinite(s)) return '';
    const fmt = (ms: number) => new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
    return Number.isFinite(e) ? `${fmt(s)} – ${fmt(e)}` : fmt(s);
}

interface DetailedLike {
    overview?: string;
    tldr?: string[];
    sectionsV3?: Array<{ title: string; bullets: Array<{ text: string; fromUserNotes?: boolean }> }>;
    keyPoints?: string[];
    actionItems?: string[];
}

export interface EnhancedSection { title: string; lines: Array<{ text: string; mine: boolean }> }

/**
 * The notes to show after Stop, in the meeting page's order: Summary, then the
 * template's sections (a line built on the user's own notes is "mine", drawn
 * in the primary ink). Older notes (no sections) fall back to key points and
 * action items. Empty when there are no notes yet.
 */
export function enhancedSections(detailed: DetailedLike | null | undefined): EnhancedSection[] {
    if (!detailed) return [];
    const out: EnhancedSection[] = [];
    const tldr = (detailed.tldr ?? []).filter((t) => typeof t === 'string' && t.trim());
    if (tldr.length) out.push({ title: 'Summary', lines: tldr.map((text) => ({ text, mine: false })) });
    const sections = (detailed.sectionsV3 ?? []).filter((s) => s && Array.isArray(s.bullets) && s.bullets.length > 0);
    for (const s of sections) {
        out.push({ title: s.title, lines: s.bullets.filter((b) => b?.text?.trim()).map((b) => ({ text: b.text, mine: !!b.fromUserNotes })) });
    }
    if (sections.length === 0) {
        if (!tldr.length && detailed.overview?.trim()) out.push({ title: 'Summary', lines: [{ text: detailed.overview.trim(), mine: false }] });
        const kp = (detailed.keyPoints ?? []).filter((t) => typeof t === 'string' && t.trim());
        if (kp.length) out.push({ title: 'Key points', lines: kp.map((text) => ({ text, mine: false })) });
        const ai = (detailed.actionItems ?? []).filter((t) => typeof t === 'string' && t.trim());
        if (ai.length) out.push({ title: 'Action items', lines: ai.map((text) => ({ text, mine: false })) });
    }
    return out.filter((s) => s.lines.length > 0);
}

/** The enhanced notes as markdown, for Copy. */
export function enhancedNotesMarkdown(title: string, sections: EnhancedSection[]): string {
    const parts = [`# ${title}`];
    for (const s of sections) parts.push(`## ${s.title}\n${s.lines.map((l) => `- ${l.text}`).join('\n')}`);
    return parts.join('\n\n');
}

/**
 * Find in the transcript, as Granola's: every place the query occurs in a
 * line (case ignored, not overlapping), in transcript order. Matches are
 * highlighted where they are; nothing is filtered out.
 */
export interface TranscriptHit { at: number; from: number; to: number }
export function findInTranscript(lines: Array<{ text: string; at: number }>, query: string): TranscriptHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: TranscriptHit[] = [];
    for (const l of lines) {
        const hay = l.text.toLowerCase();
        for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) hits.push({ at: l.at, from: i, to: i + q.length });
    }
    return hits;
}

/**
 * Granola's listening bars (RandomAudioVisualizer): three bars, the middle the
 * liveliest, each a fresh random share of the level, from a 15% nub to full.
 * `level` is 0..1; `rand` is injectable for tests.
 */
export function listeningBarHeights(level: number, rand: () => number = Math.random): number[] {
    const amp = Math.max(0, Math.min(1, level));
    return [2, 1, 2].map((k) => {
        const r = (rand() * 0.4 + 0.6) * k;
        return Math.min(Math.floor((10 * amp) / r) + 1.5, 10) / 10;
    });
}


// ── The transcript panel's pickers (2026-10-20) ─────────────────────────────

/**
 * Speech providers whose languages depend on the model or the machine (a
 * local model's set, Apple Speech's installed locales, an NVIDIA deployment,
 * Deepgram's per-model gaps). Settings › Audio filters those; the notepad
 * sends the user there rather than offer a language that would stop the
 * transcript.
 */
export const LANGUAGE_RESTRICTED_PROVIDERS: ReadonlySet<string> = new Set(['local-whisper', 'apple-speech', 'nvidia_nim', 'deepgram']);

export interface LanguageEntry { label: string; group?: string }

/** The languages the notepad offers, Auto first, then English, then by name; null: pick in Settings. */
export function notepadLanguageChoices(
    provider: string,
    languages: Record<string, LanguageEntry>,
    offered: (key: string) => boolean = () => true,
): Array<{ key: string; label: string }> | null {
    if (LANGUAGE_RESTRICTED_PROVIDERS.has(provider)) return null;
    const rank = (key: string, l: LanguageEntry) => (key === 'auto' ? 0 : l.group === 'English' ? 1 : 2);
    return Object.entries(languages)
        .filter(([key, l]) => !!l && typeof l.label === 'string' && offered(key))
        .sort(([ka, a], [kb, b]) => rank(ka, a) - rank(kb, b) || a.label.localeCompare(b.label))
        .map(([key, l]) => ({ key, label: l.label }));
}

/** The language button's word: the language's name ("English"), or "Auto detect". */
export function languageButtonLabel(key: string, languages: Record<string, LanguageEntry>): string {
    if (!key || key === 'auto') return 'Auto detect';
    const l = languages[key];
    if (!l) return 'Language';
    return l.group && l.group !== 'Auto' ? l.group : l.label;
}

/** The mic button's name: the saved device when it is still there, else the system default. */
export function micButtonLabel(devices: Array<{ id: string; name: string }>, savedId: string | null): string {
    if (savedId && savedId !== 'default') {
        const hit = devices.find((d) => d.id === savedId || d.name === savedId);
        if (hit) return hit.name;
    }
    const def = devices.find((d) => d.id === 'default');
    return def?.name && def.name !== 'default' ? def.name : 'Default microphone';
}

// ── Ask's recipes ───────────────────────────────────────────────────────────

/** How many recipes sit in the row before "All recipes" (Granola shows two). */
export const RECIPES_SHOWN = 2;

/** The recipes to draw: the first ones, or all of them once "All recipes" is open. */
export function visibleRecipes<T>(recipes: readonly T[], showAll: boolean): T[] {
    return showAll ? [...recipes] : recipes.slice(0, RECIPES_SHOWN);
}
