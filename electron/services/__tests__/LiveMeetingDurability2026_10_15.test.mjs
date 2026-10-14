// A meeting is never lost (services/meeting/LiveMeetingJournal.ts and
// MeetingPersistence's recovery): the running meeting's transcript reaches the
// database as it grows; a meeting left behind by a quit, a crash or the OS is
// turned into an unprocessed meeting at the next launch and its notes are
// written WITH its calendar event, the call's names and its mode (recovery used
// to pass none of them); a meeting whose notes are being written is never
// written twice. Run under the electron runner (better-sqlite3's ABI):
//   ELECTRON_RUN_AS_NODE=1 npx electron --test <this file>
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dist = (p) => path.join(REPO, 'dist-electron/electron', p);
const { LiveMeetingJournal } = require(dist('services/meeting/LiveMeetingJournal.js'));

// ── The journal: batching, privacy, removal (fake store and clock) ──────────

function journalRig({ snapshot } = {}) {
    let now = 1_000_000;
    const timers = [];
    const writes = [];
    const removes = [];
    let state = { transcript: [], usage: [], meta: { title: 'Sync' } };
    const j = new LiveMeetingJournal({
        store: () => ({ write: (row) => writes.push({ ...row, transcript: [...row.transcript] }), remove: (id) => removes.push(id) }),
        snapshot: snapshot ?? (() => state),
        now: () => now,
        setTimeout: (fn, ms) => { const t = { fn, at: now + ms, live: true }; timers.push(t); return t; },
        clearTimeout: (t) => { t.live = false; },
        log: () => {},
    });
    const advance = (ms) => {
        const end = now + ms;
        for (;;) {
            const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            now = due.at;
            due.live = false;
            due.fn();
        }
        now = end;
    };
    const line = (text, final = true) => { state.transcript.push({ speaker: 'interviewer', text, timestamp: now, final }); j.noteChange(final); };
    return { j, writes, removes, advance, line, setState: (s) => { state = s; }, at: () => now };
}

test('journal: a finished line reaches the disk within ~2 s, interim changes within 15 s', () => {
    const r = journalRig();
    r.j.begin('m-1', 999_000);
    r.line('hello', true);
    r.advance(1_900);
    assert.equal(r.writes.length, 0);
    r.advance(200);
    assert.equal(r.writes.length, 1);
    assert.equal(r.writes[0].id, 'm-1');
    assert.equal(r.writes[0].meta.startTime, 999_000);
    assert.equal(r.writes[0].meta.durationMs, r.writes[0].updatedAt - 999_000);
    assert.equal(r.writes[0].meta.title, 'Sync');

    r.line('typing…', false);
    r.advance(14_000);
    assert.equal(r.writes.length, 1);
    r.advance(1_000);
    assert.equal(r.writes.length, 2, 'the 15 s period');
});

test('journal: a burst of lines is one write, never more often than every 5 s', () => {
    const r = journalRig();
    r.j.begin('m-1');
    for (let i = 0; i < 50; i++) { r.line(`line ${i}`); r.advance(100); }
    r.advance(30_000);
    // 5 s of lines: written at ~2 s, then no sooner than 5 s after that.
    assert.ok(r.writes.length <= 2, `${r.writes.length} writes`);
    assert.equal(r.writes.at(-1).transcript.length, 50, 'the last write holds every line');
    const gaps = r.writes.slice(1).map((w, i) => w.updatedAt - r.writes[i].updatedAt);
    assert.ok(gaps.every((g) => g >= 5_000), gaps.join(','));
});

test('journal: a steady stream still reaches disk every period', () => {
    const r = journalRig();
    r.j.begin('m-1');
    for (let i = 0; i < 60; i++) { r.line(`interim ${i}`, false); r.advance(1_000); }
    assert.ok(r.writes.length >= 3, `${r.writes.length} writes in 60 s`);
});

test('journal: flush(quit) writes now, even with nothing new, and marks how it ended', () => {
    const r = journalRig();
    r.j.begin('m-1');
    r.line('hello');
    r.advance(3_000);
    assert.equal(r.j.flush('quit'), true);
    assert.equal(r.writes.at(-1).meta.endedBy, 'quit');
    assert.equal(r.j.flush(), false, 'a plain flush with nothing new writes nothing');
});

test('journal: nothing is written for an empty meeting, nor before begin, nor after end', () => {
    const r = journalRig();
    assert.equal(r.j.flush('quit'), false, 'no meeting');
    r.j.begin('m-1');
    assert.equal(r.j.flush('quit'), false, 'nothing said yet');
    r.line('hello');
    r.advance(3_000);
    r.j.end();
    assert.deepEqual(r.removes, ['m-1'], 'Stop removes the live copy');
    assert.equal(r.j.meetingId, null);
    r.line('late');
    r.advance(30_000);
    assert.equal(r.writes.length, 1);
    assert.equal(r.j.flush('quit'), false);
});

test('journal: retention "never" / do-not-persist (snapshot null) writes nothing and removes what was written', () => {
    let keep = true;
    const state = { transcript: [{ speaker: 'user', text: 'x', timestamp: 1 }], usage: [], meta: {} };
    const r = journalRig({ snapshot: () => (keep ? state : null) });
    r.j.begin('m-1');
    r.j.noteChange(true);
    r.advance(3_000);
    assert.equal(r.writes.length, 1);
    keep = false;
    r.j.noteChange(true);
    r.advance(10_000);
    assert.equal(r.writes.length, 1);
    assert.deepEqual(r.removes, ['m-1']);
    assert.equal(r.j.flush('quit'), false);
});

test('journal: a failed write is retried on the next period, not on every line', () => {
    let fail = true;
    let attempts = 0;
    let now = 0;
    const timers = [];
    const j = new LiveMeetingJournal({
        store: () => ({ write: () => { attempts++; if (fail) throw new Error('SQLITE_BUSY'); }, remove: () => {} }),
        snapshot: () => ({ transcript: [{ speaker: 'user', text: 'x', timestamp: 1 }], usage: [], meta: {} }),
        now: () => now,
        setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
        clearTimeout: () => {},
        log: () => {},
    });
    j.begin('m-1');
    j.noteChange(true);
    now = 2_000; timers.shift().fn();
    assert.equal(attempts, 1);
    assert.equal(timers.at(-1).at, 17_000, 'next try one period later');
    fail = false;
    now = 17_000; timers.pop().fn();
    assert.equal(attempts, 2);
});

// ── End to end: the database, recovery, metadata, no double processing ──────

describe('a meeting left behind, recovered', () => {
    let tmpDir;
    let MeetingPersistence;
    let DatabaseManager;
    let Database;
    let recoveryMetadataFor;
    const originalLoad = Module._load;
    const KEY = 'meet:abc-defg-hij';
    const SNAPSHOT = {
        id: 'evt-1on1',
        title: '1:1 with Priya',
        startTime: '2026-10-15T10:00:00.000Z',
        endTime: '2026-10-15T10:30:00.000Z',
        attendees: [{ email: 'priya@acme.com', name: 'Priya Nair', response: 'accepted' }],
        linkedBy: 'start',
    };

    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-live-durability-'));
        process.env.NATIVELY_TEST_USERDATA = tmpDir;
        process.env.NATIVELY_MEETING_SUMMARY_V3 = 'false';
        process.env.NATIVELY_MEETING_MODE_AUTODETECT = 'false';
        const electronStub = {
            app: { getPath: () => tmpDir, isPackaged: false, isReady: () => true, getVersion: () => '0.0.0', on: () => {}, whenReady: () => Promise.resolve() },
            BrowserWindow: { getAllWindows: () => [] },
            safeStorage: { isEncryptionAvailable: () => false },
            shell: {}, ipcMain: { handle: () => {}, on: () => {} },
            Notification: class { static isSupported() { return false; } on() {} show() {} },
        };
        Module._load = function (request, parent, isMain) {
            if (request === 'electron') return electronStub;
            return originalLoad.call(this, request, parent, isMain);
        };
        ({ MeetingPersistence, recoveryMetadataFor } = require(dist('MeetingPersistence.js')));
        ({ DatabaseManager } = require(dist('db/DatabaseManager.js')));
        Database = require('better-sqlite3');
    });
    after(() => {
        Module._load = originalLoad;
        delete process.env.NATIVELY_MEETING_SUMMARY_V3;
        delete process.env.NATIVELY_MEETING_MODE_AUTODETECT;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    // Counts runs of the NOTES. The post-save speaker-name suggestion
    // (speakerNameSuggestions.ts) goes through the same model call; it is a
    // separate feature and not a second run of the notes, so it is not counted.
    const llmRecording = (calls, { delay = 0 } = {}) => new Proxy({
        generateMeetingSummary: async (p, context) => {
            if (String(p).startsWith('You match unnamed voices in a meeting transcript')) return '{"mappings":[]}';
            calls.push(String(context));
            if (delay) await new Promise((r) => setTimeout(r, delay));
            return JSON.stringify({ overview: 'Pricing deck by Friday.', keyPoints: ['Deck by Friday'], actionItems: ['Send the deck'] });
        },
    }, { get: (o, k) => (k in o ? o[k] : async () => '') });

    /** Four spoken lines: enough for the notes pipeline to call the model. */
    const fourLines = (start) => [
        { speaker: 'user', text: 'Can you send the pricing deck by Friday?', timestamp: start + 1000, origin: 'stt', final: true },
        { speaker: 'interviewer', text: 'Yes, I will send the pricing deck by Friday.', timestamp: start + 4000, origin: 'stt', final: true },
        { speaker: 'user', text: 'Great, and the renewal terms too.', timestamp: start + 8000, origin: 'stt', final: true },
        { speaker: 'interviewer', text: 'Sure, renewal terms as well.', timestamp: start + 12000, origin: 'stt', final: true },
    ];

    /** A session that holds one running meeting, as SessionTracker would. */
    const fakeSession = (startedAt, transcript, metadata) => {
        let lines = [...transcript];
        let meta = metadata;
        return {
            flushInterimTranscript() {},
            getSessionStartTime: () => startedAt,
            getMeetingMetadata: () => meta,
            getFullTranscript: () => lines,
            getFullUsage: () => [],
            getFullSessionContext: () => '',
            reset() { lines = []; meta = null; },
        };
    };
    const readDb = (fn) => {
        const db = new Database(path.join(tmpDir, 'natively.db'), { readonly: true });
        try { return fn(db); } finally { db.close(); }
    };

    test('a live row from a quit becomes a meeting; its notes are written with the calendar and the call\'s names', async () => {
        const start = Date.now() - 60_000;
        const t = (s) => start + s * 1000;
        const transcript = [
            { speaker: 'interviewer', text: 'Hi everyone, this is Priya, let us go over the launch plan today', timestamp: t(6.2), origin: 'stt', final: true },
            { speaker: 'user', text: 'Sounds good to me.', timestamp: t(6.9), origin: 'stt', final: true },
            { speaker: 'interviewer', text: 'I will send the pricing deck by Friday', timestamp: t(12.3), origin: 'stt', final: true },
        ];
        // The process that quit: its roster said Priya spoke 0–6 s and Rob 7–12 s.
        DatabaseManager.getInstance().writeLiveMeeting({
            id: 'live-quit-1', startedAt: start, updatedAt: t(20), transcript, usage: [],
            meta: {
                title: '1:1 with Priya', calendarEventId: SNAPSHOT.id, calendarEvent: SNAPSHOT, source: 'calendar', callKey: KEY,
                callRoster: { participants: ['Priya Nair', 'Rob Lane'], spans: [{ name: 'Priya Nair', start: t(0), end: t(6) }, { name: 'Rob Lane', start: t(7), end: t(12) }] },
                mode: null, startTime: start, durationMs: 20_000, endedBy: 'quit',
            },
        });
        const calls = [];
        const mp = new MeetingPersistence(fakeSession(Date.now(), [], null), llmRecording(calls));
        await mp.recoverUnprocessedMeetings();

        assert.equal(calls.length, 1, 'notes written once');
        assert.match(calls[0], /Priya Nair:/, 'the call\'s names reached the notes (a restarted app has no roster)');
        assert.match(calls[0], /Rob Lane:/);
        const row = readDb((db) => db.prepare('SELECT is_processed, calendar_event_id, recovery_meta_json, start_time, duration_ms FROM meetings WHERE id = ?').get('live-quit-1'));
        assert.equal(row.is_processed, 1);
        assert.equal(row.calendar_event_id, SNAPSHOT.id);
        assert.equal(row.recovery_meta_json, null, 'cleared once processed');
        assert.equal(row.start_time, start);
        assert.equal(row.duration_ms, 20_000);
        assert.equal(readDb((db) => db.prepare('SELECT COUNT(*) AS n FROM live_meeting_journal').get().n), 0, 'the live copy is gone');
        const ids = readDb((db) => db.prepare('SELECT speaker_id FROM transcripts WHERE meeting_id = ? ORDER BY timestamp_ms').all('live-quit-1').map((r) => r.speaker_id));
        assert.deepEqual(ids, ['speaker_2', null, 'speaker_3']);
    });

    test('regression: a placeholder whose notes never got written is recovered with its metadata (it used to get none)', async () => {
        const start = Date.now() - 120_000;
        const transcript = fourLines(start);
        // What Stop saves before the notes: a placeholder with its recovery metadata.
        DatabaseManager.getInstance().saveMeeting({
            id: 'placeholder-1', title: 'Processing...', date: new Date().toISOString(), duration: '2:00', summary: 'Generating summary...',
            detailedSummary: { actionItems: [], keyPoints: [] }, transcript, usage: [], isProcessed: false, summaryStatus: 'queued',
            calendarEventId: SNAPSHOT.id, calendarEvent: SNAPSHOT, source: 'calendar',
            recoveryMeta: { title: '1:1 with Priya', calendarEventId: SNAPSHOT.id, calendarEvent: SNAPSHOT, source: 'calendar', mode: null, startTime: start, durationMs: 120_000 },
        }, start, 120_000);
        assert.ok(DatabaseManager.getInstance().getMeetingRecoveryMeta('placeholder-1'));

        const calls = [];
        const mp = new MeetingPersistence(fakeSession(Date.now(), [], null), llmRecording(calls));
        await mp.recoverUnprocessedMeetings();
        assert.equal(calls.length, 1);
        assert.match(calls[0], /Priya:/, 'the calendar 1:1 names the other voice in the notes');
        const title = readDb((db) => db.prepare('SELECT title FROM meetings WHERE id = ?').get('placeholder-1').title);
        assert.notEqual(title, 'Processing...');
    });

    test('recoveryMetadataFor: saved metadata wins; the row\'s own calendar link is the fallback; nothing = null', () => {
        const fromRow = recoveryMetadataFor({ calendarEventId: SNAPSHOT.id, calendarEvent: SNAPSHOT, source: 'calendar' }, null);
        assert.deepEqual(fromRow.metadata, { calendarEventId: SNAPSHOT.id, calendarEvent: SNAPSHOT, title: SNAPSHOT.title, source: 'calendar' });
        assert.equal(fromRow.mode, null);
        const saved = recoveryMetadataFor({}, { callKey: KEY, callRoster: { participants: ['A'], spans: [] }, mode: { id: 'm1', name: 'Sales', templateType: 'sales' }, title: 'Deal review' });
        assert.equal(saved.metadata.callKey, KEY);
        assert.deepEqual(saved.mode, { id: 'm1', name: 'Sales', templateType: 'sales' });
        assert.equal(saved.metadata.title, 'Deal review');
        assert.deepEqual(recoveryMetadataFor({}, null), { metadata: null, mode: null });
        // An event snapshot for a different event than the link is not used.
        assert.equal(recoveryMetadataFor({ calendarEventId: 'other', calendarEvent: SNAPSHOT }, null).metadata.calendarEvent, undefined);
    });

    test('Stop saves under the live copy\'s id and removes it; a recovery during the notes does not write them twice', async () => {
        const start = Date.now() - 30_000;
        const transcript = fourLines(start);
        const calls = [];
        const mp = new MeetingPersistence(fakeSession(start, transcript, { title: 'Launch' }), llmRecording(calls, { delay: 150 }));
        const id = mp.beginLiveMeeting(start);
        assert.equal(mp.flushLiveMeeting('quit'), true, 'the running meeting reaches the disk');
        assert.equal(readDb((db) => db.prepare('SELECT COUNT(*) AS n FROM live_meeting_journal WHERE id = ?').get(id).n), 1);

        // A recovery pass while the meeting runs leaves its live copy alone.
        await mp.recoverUnprocessedMeetings();
        assert.equal(readDb((db) => db.prepare('SELECT COUNT(*) AS n FROM live_meeting_journal WHERE id = ?').get(id).n), 1);
        assert.equal(readDb((db) => db.prepare('SELECT COUNT(*) AS n FROM meetings WHERE id = ?').get(id).n), 0);

        const result = await mp.stopMeeting();
        assert.equal(result.meetingId, id, 'the saved meeting replaces the live copy, never a second meeting');
        assert.equal(readDb((db) => db.prepare('SELECT COUNT(*) AS n FROM live_meeting_journal WHERE id = ?').get(id).n), 0);
        assert.ok(DatabaseManager.getInstance().getMeetingRecoveryMeta(id), 'the placeholder carries its recovery metadata');

        // The notes are being written (150 ms model); a recovery now must skip it.
        await mp.recoverUnprocessedMeetings();
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(calls.length, 1, 'one run of the notes');
        assert.equal(readDb((db) => db.prepare('SELECT is_processed FROM meetings WHERE id = ?').get(id).is_processed), 1);
    });

    test('two recovery calls at once share one pass', async () => {
        const start = Date.now() - 30_000;
        DatabaseManager.getInstance().writeLiveMeeting({
            id: 'live-twice', startedAt: start, updatedAt: start + 20_000,
            transcript: fourLines(start),
            usage: [], meta: { startTime: start, durationMs: 20_000 },
        });
        const calls = [];
        const mp = new MeetingPersistence(fakeSession(Date.now(), [], null), llmRecording(calls, { delay: 50 }));
        const a = mp.recoverUnprocessedMeetings();
        const b = mp.recoverUnprocessedMeetings();
        assert.equal(a, b);
        await Promise.all([a, b]);
        assert.equal(calls.length, 1);
        const row = readDb((db) => db.prepare('SELECT is_processed FROM meetings WHERE id = ?').get('live-twice'));
        assert.equal(row.is_processed, 1);
    });

    test('a live row already saved by Stop (crash between the two writes) is not duplicated', () => {
        const db = DatabaseManager.getInstance();
        const start = Date.now() - 10_000;
        const meeting = { id: 'both-1', title: 'Processing...', date: new Date().toISOString(), duration: '0:10', summary: '', detailedSummary: { actionItems: [], keyPoints: [] }, transcript: [{ speaker: 'user', text: 'hi', timestamp: start }], usage: [], isProcessed: false, summaryStatus: 'queued' };
        db.saveMeeting(meeting, start, 10_000);
        db.writeLiveMeeting({ id: 'both-1', startedAt: start, updatedAt: start + 9_000, transcript: [{ speaker: 'user', text: 'different', timestamp: start }], usage: [], meta: {} });
        assert.equal(db.promoteLiveMeeting({ ...meeting, transcript: [{ speaker: 'user', text: 'different', timestamp: start }] }, start, 9_000), false);
        assert.equal(readDb((d) => d.prepare('SELECT COUNT(*) AS n FROM live_meeting_journal WHERE id = ?').get('both-1').n), 0);
        assert.equal(readDb((d) => d.prepare('SELECT content FROM transcripts WHERE meeting_id = ?').get('both-1').content), 'hi', 'the saved meeting is kept as it was');
        db.saveMeeting({ ...meeting, isProcessed: true, summaryStatus: 'completed' }, start, 10_000); // out of the way of later tests
    });

    test('guards: retention "never" drops a left-over live meeting; under 1 s or empty too', async () => {
        const db = DatabaseManager.getInstance();
        const { SettingsManager } = require(dist('services/SettingsManager.js'));
        const settings = SettingsManager.getInstance();
        const before = settings.get('meetingRetention');
        const now = Date.now();
        db.writeLiveMeeting({ id: 'live-never', startedAt: now - 60_000, updatedAt: now, transcript: [{ speaker: 'user', text: 'secret', timestamp: now }], usage: [], meta: { startTime: now - 60_000, durationMs: 60_000 } });
        db.writeLiveMeeting({ id: 'live-short', startedAt: now - 500, updatedAt: now, transcript: [{ speaker: 'user', text: 'x', timestamp: now }], usage: [], meta: { startTime: now - 500, durationMs: 500 } });
        settings.set('meetingRetention', 'never');
        try {
            const calls = [];
            await new MeetingPersistence(fakeSession(now, [], null), llmRecording(calls)).recoverUnprocessedMeetings();
            assert.equal(readDb((d) => d.prepare("SELECT COUNT(*) AS n FROM live_meeting_journal WHERE id IN ('live-never','live-short')").get().n), 0);
            assert.equal(readDb((d) => d.prepare("SELECT COUNT(*) AS n FROM meetings WHERE id IN ('live-never','live-short')").get().n), 0, 'never saved');
            assert.equal(calls.length, 0);
        } finally {
            settings.set('meetingRetention', before ?? 'forever');
        }
        // And while a meeting runs under "never", nothing reaches the disk at all.
        settings.set('meetingRetention', 'never');
        try {
            const mp = new MeetingPersistence(fakeSession(now, [{ speaker: 'user', text: 'x', timestamp: now, origin: 'stt' }], null), llmRecording([]));
            const id = mp.beginLiveMeeting(now - 5_000);
            assert.equal(mp.flushLiveMeeting('quit'), false);
            assert.equal(readDb((d) => d.prepare('SELECT COUNT(*) AS n FROM live_meeting_journal WHERE id = ?').get(id).n), 0);
        } finally {
            settings.set('meetingRetention', before ?? 'forever');
        }
    });

    test('do-not-persist on the meeting: nothing written while it runs, and Stop leaves no row', async () => {
        const now = Date.now();
        const mp = new MeetingPersistence(fakeSession(now - 5_000, [{ speaker: 'user', text: 'x', timestamp: now, origin: 'stt' }], { doNotPersist: true }), llmRecording([]));
        const id = mp.beginLiveMeeting(now - 5_000);
        assert.equal(mp.flushLiveMeeting('quit'), false);
        assert.equal(await mp.stopMeeting(), null);
        assert.equal(readDb((d) => d.prepare('SELECT COUNT(*) AS n FROM meetings WHERE id = ?').get(id).n), 0);
        assert.equal(readDb((d) => d.prepare('SELECT COUNT(*) AS n FROM live_meeting_journal WHERE id = ?').get(id).n), 0);
    });

    test('clearAllData clears meetings in progress too', () => {
        const db = DatabaseManager.getInstance();
        db.writeLiveMeeting({ id: 'live-wipe', startedAt: 1, updatedAt: 2, transcript: [], usage: [], meta: {} });
        assert.equal(db.clearAllData(), true);
        assert.equal(readDb((d) => d.prepare('SELECT COUNT(*) AS n FROM live_meeting_journal').get().n), 0);
    });
});
