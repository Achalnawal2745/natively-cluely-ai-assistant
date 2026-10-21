// The notepad's "Add to folder" (2026-10-20, services/meeting/liveNotesSession.ts):
// a live meeting has no id yet, so the choice is held and filed when Stop saves
// it; after Stop it files at once. Pure module, no platform branches: the same
// on macOS and Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { LiveNotesSession } = require(path.resolve(root, 'dist-electron/electron/services/meeting/liveNotesSession.js'));


test('live: the choice is held (no id yet) and filed when Stop saves the meeting', () => {
    const filed = [];
    const s = new LiveNotesSession({ setLive() {}, saveEnded() {}, broadcast() {}, fileInFolder: (...a) => { filed.push(a); return true; } });
    s.meetingStarted();
    assert.equal(s.setFolder('f1', true), true);
    assert.equal(s.setFolder('f2', true), true);
    assert.equal(s.setFolder('f2', false), true);
    assert.deepEqual(s.getFolders(), ['f1']);
    assert.deepEqual(filed, [], 'nothing filed while live');
    s.meetingEnded('m1');
    assert.deepEqual(filed, [['m1', 'f1', true]]);
});

test('a meeting that was not kept files nothing; a new meeting starts with no folders', () => {
    const filed = [];
    const s = new LiveNotesSession({ setLive() {}, saveEnded() {}, broadcast() {}, fileInFolder: (...a) => { filed.push(a); return true; } });
    s.meetingStarted();
    s.setFolder('f1', true);
    s.meetingEnded(null);
    assert.deepEqual(filed, []);
    assert.equal(s.setFolder('f1', true), false, 'no saved meeting to file');
    s.meetingStarted();
    assert.deepEqual(s.getFolders(), []);
});

test('after Stop: files at once, keeps the set only when the store took it', () => {
    const filed = [];
    let ok = true;
    const s = new LiveNotesSession({ setLive() {}, saveEnded() {}, broadcast() {}, fileInFolder: (...a) => { filed.push(a); return ok; } });
    s.meetingStarted();
    s.meetingEnded('m2');
    assert.equal(s.setFolder('f3', true), true);
    assert.deepEqual(filed, [['m2', 'f3', true]]);
    assert.deepEqual(s.getFolders(), ['f3']);
    ok = false;
    assert.equal(s.setFolder('f4', true), false);
    assert.deepEqual(s.getFolders(), ['f3']);
    ok = true;
    assert.equal(s.setFolder('f3', false), true);
    assert.deepEqual(s.getFolders(), []);
});

test('bad input is refused; a throwing store never breaks Stop', () => {
    const s = new LiveNotesSession({ setLive() {}, saveEnded() {}, broadcast() {}, fileInFolder: () => { throw new Error('db'); } });
    s.meetingStarted();
    for (const [id, on] of [[42, true], ['', true], ['x'.repeat(201), true], ['f1', 'yes']]) assert.equal(s.setFolder(id, on), false);
    s.setFolder('f1', true);
    assert.doesNotThrow(() => s.meetingEnded('m3'));
    assert.equal(s.getState().phase, 'ended');
    assert.equal(s.setFolder('f2', true), false);
});

test('wiring: the IPC, preload and main hand the folder button to the session and OrganiseStore', () => {
    const read = (p) => readFileSync(path.join(root, p), 'utf8');
    const ipc = read('electron/ipcHandlers.ts');
    for (const channel of ['live-notes:folders', 'live-notes:set-folder', 'live-notes:create-folder']) assert.match(ipc, new RegExp(`safeHandle\\('${channel}'`), channel);
    const preload = read('electron/preload.ts');
    for (const name of ['liveNotesFolders', 'liveNotesSetFolder', 'liveNotesCreateFolder']) assert.match(preload, new RegExp(`\\b${name}:`), name);
    assert.match(read('electron/main.ts'), /fileInFolder[\s\S]{0,400}addMeetingToFolder/);
});
