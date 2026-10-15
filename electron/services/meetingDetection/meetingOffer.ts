/**
 * The "meeting detected" offer (2026-10-15): one offer per detected call, shown
 * on two synced surfaces, with an optional automatic start.
 *
 *   - The launcher's own panel (a corner notice in the launcher window), when
 *     the launcher has a live renderer: it shows while the launcher is on
 *     screen.
 *   - The OS notification (the one detection always showed), unless the user
 *     is looking at the launcher right now: a call usually starts with the call
 *     app in front and Natively hidden.
 *
 * Start on either surface starts Natively; Not now on either clears both. With
 * "Start automatically" on (Settings › Calendar, default off), Natively starts
 * itself `countdownMs` after the offer unless Not now was pressed. An offer
 * nobody answers clears itself after `expireMs`.
 *
 * Never shown at all while Undetectable blocks native prompts or a disguise is
 * on (the caller, wireMeetingDetection, checks before offering): the same rule
 * the notification always followed, so the countdown never runs unseen either.
 *
 * Pure: timers, clock and surfaces are injected, so the state machine is tested
 * without Electron.
 */

export interface MeetingStartRequestLike {
    title?: string;
    calendarEventId?: string;
    via: 'detected' | 'reminder';
}

/** What the launcher's panel shows. */
export interface MeetingOfferView {
    id: string;
    /** The calendar event's title when one is on, else the call's own name, else null. */
    title: string | null;
    /** "Zoom", "Google Meet". */
    app: string;
    /** The notification's sentence, for the panel's second line. */
    body: string;
    /** Wall time of the automatic start, or null when it is off. */
    autoStartAt: number | null;
}

export interface OfferNotification {
    title: string;
    body: string;
    action: string;
    onStart: () => void;
    /** The user closed the notification (Not now). */
    onDismiss?: () => void;
}

export interface MeetingOfferDeps {
    isMeetingActive: () => boolean;
    requestStart: (req: MeetingStartRequestLike) => void;
    /** Settings › Calendar › Start automatically. */
    autoStart: () => boolean;
    /** The launcher's panel: an offer to show, or null to clear it. */
    showPanel: (offer: MeetingOfferView | null) => void;
    /** Shows the OS notification; false when the OS has none. */
    notify: (n: OfferNotification) => boolean;
    /** Closes the notification this controller showed last, if it is still up. */
    closeNotification: () => void;
    /** The launcher is on screen and in front: its panel is enough. */
    launcherFocused: () => boolean;
    now?: () => number;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
    log?: (line: string) => void;
}

export const OFFER_COUNTDOWN_MS = 10_000;
export const OFFER_EXPIRE_MS = 120_000;

/** The notification's text for an offer (exported for the tests). */
export function offerNotificationText(body: string, autoStart: boolean, countdownMs: number): { title: string; body: string; action: string } {
    if (!autoStart) return { title: 'Start Natively?', body, action: 'Start Natively' };
    const seconds = Math.max(1, Math.round(countdownMs / 1000));
    return { title: 'Starting Natively', body: `${body}\nNatively starts in ${seconds} seconds.`, action: 'Start now' };
}

/**
 * Whether a notification's close means Not now. macOS emits close only when the
 * user closes it; Windows also closes a toast that timed out into the Action
 * Center (reason "timedOut"), which is not a no.
 */
export function closeMeansNotNow(platform: string, reason: string | undefined): boolean {
    if (platform === 'win32') return reason === 'userCanceled';
    return true;
}

interface Current {
    view: MeetingOfferView;
    start: MeetingStartRequestLike;
    countdown: unknown;
    expiry: unknown;
}

export class MeetingOffers {
    private current: Current | null = null;
    private seq = 0;
    private readonly now: () => number;
    private readonly setT: (fn: () => void, ms: number) => unknown;
    private readonly clearT: (h: unknown) => void;

    constructor(
        private readonly deps: MeetingOfferDeps,
        private readonly options: { countdownMs?: number; expireMs?: number } = {},
    ) {
        this.now = deps.now ?? Date.now;
        this.setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    }

    private get countdownMs(): number {
        return this.options.countdownMs ?? OFFER_COUNTDOWN_MS;
    }

    /** The offer on screen, if any. */
    view(): MeetingOfferView | null {
        return this.current?.view ?? null;
    }

    /** A new call: replaces any earlier offer. */
    offer(input: { app: string; title?: string | null; body: string; start: MeetingStartRequestLike }): MeetingOfferView {
        this.clear('replaced');
        const auto = (() => { try { return this.deps.autoStart(); } catch { return false; } })();
        const id = `offer-${++this.seq}`;
        const view: MeetingOfferView = {
            id,
            title: input.start.title ?? input.title ?? null,
            app: input.app,
            body: input.body,
            autoStartAt: auto ? this.now() + this.countdownMs : null,
        };
        const current: Current = {
            view,
            start: input.start,
            countdown: auto ? this.setT(() => this.fire(id), this.countdownMs) : null,
            expiry: this.setT(() => { if (this.current?.view.id === id) this.clear('expired'); }, this.options.expireMs ?? OFFER_EXPIRE_MS),
        };
        this.current = current;
        try { this.deps.showPanel(view); } catch { /* the notification still shows */ }
        let focused = false;
        try { focused = this.deps.launcherFocused(); } catch { /* not focused */ }
        if (!focused) {
            const text = offerNotificationText(input.body, auto, this.countdownMs);
            const startReq = input.start;
            const shown = this.deps.notify({
                ...text,
                // A notification's Start acts on its own call even after the
                // panel moved on; a meeting already running wins.
                onStart: () => {
                    if (this.current?.view.id === id) this.clear('started');
                    if (!this.deps.isMeetingActive()) this.deps.requestStart(startReq);
                },
                onDismiss: () => this.dismiss(id),
            });
            this.deps.log?.(`offer ${id}: notification ${shown ? 'shown' : 'not supported'}${auto ? ', starts automatically' : ''}`);
        } else {
            this.deps.log?.(`offer ${id}: launcher in front, panel only${auto ? ', starts automatically' : ''}`);
        }
        return view;
    }

    /** Start pressed on the panel. False when that offer is gone. */
    start(id: string): boolean {
        const cur = this.current;
        if (!cur || cur.view.id !== id) return false;
        this.clear('started');
        if (this.deps.isMeetingActive()) return false;
        this.deps.requestStart(cur.start);
        return true;
    }

    /** Not now, on either surface. */
    dismiss(id: string): void {
        if (this.current?.view.id === id) this.clear('dismissed');
    }

    /** A meeting started some other way, or detection was switched off. */
    clear(reason = 'cleared'): void {
        const cur = this.current;
        if (!cur) return;
        this.current = null;
        if (cur.countdown !== null) this.clearT(cur.countdown);
        this.clearT(cur.expiry);
        try { this.deps.showPanel(null); } catch { /* window gone */ }
        // Both surfaces go together (closing one that already closed is a no-op).
        try { this.deps.closeNotification(); } catch { /* already gone */ }
        this.deps.log?.(`offer ${cur.view.id}: ${reason}`);
    }

    private fire(id: string): void {
        const cur = this.current;
        if (!cur || cur.view.id !== id) return;
        this.clear('auto-started');
        if (this.deps.isMeetingActive()) return;
        this.deps.requestStart(cur.start);
    }
}

// ── Calendar reminder timing (Settings › Calendar) ───────────────────────

export const REMINDER_MINUTE_CHOICES = [1, 2, 5] as const;
export const DEFAULT_REMINDER_MINUTES = 2;

/** The saved reminder lead time, or the default for anything else. */
export function reminderMinutes(raw: unknown): number {
    return typeof raw === 'number' && (REMINDER_MINUTE_CHOICES as readonly number[]).includes(raw) ? raw : DEFAULT_REMINDER_MINUTES;
}

/** "starts in 1 minute" / "starts in 2 minutes". */
export function reminderLeadText(minutes: number): string {
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}
