// Granola parity round 2, outputs (2026-10-15): source-level wiring checks that
// need no build. Settings has a Connections tab in its nav order, nav and
// panel; the meeting page mounts the Share menu beside Copy; and the preload
// bridge and the main-process handlers agree on every outputs channel, so a
// renamed channel cannot leave a button that silently does nothing.
//
// Run: node --test src/components/__tests__/MeetingOutputsWiring2026_10_15.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

test('Settings: connections sits after calendar in SETTINGS_NAV_ORDER, with a nav button and a panel', () => {
    const src = read('src/components/SettingsOverlay.tsx');
    const order = src.match(/const SETTINGS_NAV_ORDER = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
    assert.equal(order[order.indexOf('calendar') + 1], 'connections');
    assert.match(src, /onClick=\{\(\) => setActiveTab\('connections'\)\}/);
    assert.match(src, /\{activeTab === 'connections' && <ConnectionsSettings \/>\}/);
});

test('meeting page: the Share menu is mounted next to Copy', () => {
    const src = read('src/components/MeetingDetails.tsx');
    assert.match(src, /import \{ ShareMenu \} from '\.\/meeting\/ShareMenu';/);
    assert.match(src, /<ShareMenu\s+meetingId=\{meeting\.id\}/);
});

test('preload and main agree on every outputs channel', () => {
    const preload = new Set([...read('electron/preload.ts').matchAll(/ipcRenderer\.invoke\('(outputs:[a-z-]+)'/g)].map((m) => m[1]));
    const main = new Set([...read('electron/services/outputs/outputsIpc.ts').matchAll(/safeHandle\('(outputs:[a-z-]+)'/g)].map((m) => m[1]));
    assert.ok(preload.size >= 20);
    assert.deepEqual([...preload].sort(), [...main].sort());
});

test('opening the Share menu reads connection status only; sends happen from a Send button', () => {
    const src = read('src/components/meeting/ShareMenu.tsx');
    const openMenu = src.match(/const openMenu = \(\) => \{([\s\S]*?)\n    \};/)[1];
    assert.ok(!/send(Slack|Notion|Crm)|export(Pdf|Html)/.test(openMenu));
    // One Send each; Notion's second call is the explicit "Start over with a new page".
    const count = (fn) => (src.match(new RegExp(`api\\(\\)\\?\\.${fn}\\(`, 'g')) || []).length;
    assert.equal(count('sendSlack'), 1);
    assert.equal(count('sendCrm'), 1);
    assert.equal(count('sendNotion'), 2);
    assert.equal((src.match(/sendNotion\(meetingId, \{ includeTranscript, startOver: true \}\)/g) || []).length, 1);
});

test('Salesforce is left as a clear TODO, not half-built', () => {
    assert.match(read('electron/services/outputs/crm.ts'), /TODO\(salesforce\): Salesforce is not built\. Its REST API needs an OAuth\s+\/\/ connected app/);
});
