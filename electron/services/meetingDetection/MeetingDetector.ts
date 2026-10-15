/**
 * Watches for a call starting and asks once per call whether to start
 * Natively (the notification is the caller's: `onDetected`).
 *
 * Every `pollMs` it reads the signals (detectMeeting.ts). A call must hold for
 * `confirmMs` before it is announced, so a microphone test or a two-second
 * voice note isn't (a chat app's, `messagingConfirmMs`: voice notes there run
 * longer); it is announced once, and only announced again after it
 * has been gone for `rearmMs` (a new call). While a Natively meeting runs,
 * whatever call is on counts as handled, so stopping Natively mid-call doesn't
 * prompt for that same call.
 *
 * Timers and clock are injected for the tests; polling runs only while enabled.
 */
import { detectMeeting, type DetectInput, type Detection } from './detectMeeting';

export interface MeetingDetectorDeps {
    /** Everything detectMeeting needs, read fresh on each poll. */
    read: () => DetectInput;
    isMeetingActive: () => boolean;
    onDetected: (detection: Detection) => void;
    /** An announced call is no longer seen (once, until it is seen again). */
    onGone?: (id: string) => void;
    now?: () => number;
    setInterval?: (fn: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
}

export interface MeetingDetectorOptions {
    pollMs?: number;
    confirmMs?: number;
    /** A chat app's call (WhatsApp, Slack…): long enough that a voice note is not one. */
    messagingConfirmMs?: number;
    rearmMs?: number;
}

interface CallRecord {
    firstSeen: number;
    lastSeen: number;
    announced: boolean;
    goneReported?: boolean;
}

export class MeetingDetector {
    private readonly pollMs: number;
    private readonly confirmMs: number;
    private readonly messagingConfirmMs: number;
    private readonly rearmMs: number;
    private readonly now: () => number;
    private timer: unknown = null;
    private calls = new Map<string, CallRecord>();
    private lastTickAt = -1;

    constructor(private readonly deps: MeetingDetectorDeps, options: MeetingDetectorOptions = {}) {
        this.pollMs = options.pollMs ?? 2_000;
        this.confirmMs = options.confirmMs ?? 4_000;
        this.messagingConfirmMs = options.messagingConfirmMs ?? 20_000;
        this.rearmMs = options.rearmMs ?? 60_000;
        this.now = deps.now ?? Date.now;
    }

    setEnabled(on: boolean): void {
        if (on && this.timer === null) {
            const set = this.deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
            this.timer = set(() => this.tick(), this.pollMs);
        } else if (!on && this.timer !== null) {
            (this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer);
            this.timer = null;
            this.calls.clear();
        }
    }

    get enabled(): boolean {
        return this.timer !== null;
    }

    /** Whether call `id` was seen at the latest poll. */
    isPresent(id: string): boolean {
        const call = this.calls.get(id);
        return !!call && call.lastSeen === this.lastTickAt;
    }

    /** One poll. Public for the tests. */
    tick(): void {
        const now = this.now();
        let detection: Detection | null = null;
        try {
            detection = detectMeeting(this.deps.read());
        } catch (err) {
            console.warn('[MeetingDetector] reading the signals failed:', (err as Error)?.message);
        }
        if (detection) {
            const call = this.calls.get(detection.id) ?? { firstSeen: now, lastSeen: now, announced: false };
            call.lastSeen = now;
            call.goneReported = false;
            this.calls.set(detection.id, call);
            if (this.deps.isMeetingActive()) {
                call.announced = true;
            } else if (!call.announced && now - call.firstSeen >= (detection.messaging ? this.messagingConfirmMs : this.confirmMs)) {
                call.announced = true;
                try {
                    this.deps.onDetected(detection);
                } catch (err) {
                    console.warn('[MeetingDetector] onDetected failed:', (err as Error)?.message);
                }
            }
        }
        this.lastTickAt = now;
        for (const [id, call] of this.calls) {
            // An announced call missing from this poll: whoever waits on it
            // (the offer's automatic start) hears at once.
            if (call.announced && call.lastSeen < now && !call.goneReported) {
                call.goneReported = true;
                try { this.deps.onGone?.(id); } catch (err) { console.warn('[MeetingDetector] onGone failed:', (err as Error)?.message); }
            }
            // Gone long enough: the next one is a new call. Gone briefly before
            // being announced: start the confirmation over.
            if (now - call.lastSeen >= this.rearmMs || (!call.announced && call.lastSeen < now)) this.calls.delete(id);
        }
    }
}
