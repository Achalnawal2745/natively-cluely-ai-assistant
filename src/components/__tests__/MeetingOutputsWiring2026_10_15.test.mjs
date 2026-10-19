// Granola parity round 2, outputs (2026-10-15): source-level wiring checks that
// need no build. Settings has a Connections tab in its nav order, nav and
// panel; the meeting page mounts the Share menu beside Copy; and the preload
// bridge and the main-process handlers agree on every outputs channel, so a
// renamed channel cannot leave a button that silently does nothing.
//
// Run: node --test src/components/__tests__/MeetingOutputsWiring2026_10_15.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

test('Settings: connections sits between audio and help in SETTINGS_NAV_ORDER, with a nav button and a panel', () => {
    const src = read('src/components/SettingsOverlay.tsx');
    const order = src.match(/const SETTINGS_NAV_ORDER = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
    assert.ok(order.indexOf('connections') > order.indexOf('audio'));
    assert.ok(order.indexOf('connections') < order.indexOf('help'));
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
    const openMenu = src.match(/const openMenu = \([^)]*\) => \{([\s\S]*?)\n    \};/)[1];
    assert.ok(!/send(Slack|Notion|Crm)|export(Pdf|Html)/.test(openMenu));
    // One Send each; Notion's second call is the explicit "Start over with a new page".
    const count = (fn) => (src.match(new RegExp(`api\\(\\)\\?\\.${fn}\\(`, 'g')) || []).length;
    assert.equal(count('sendSlack'), 1);
    assert.equal(count('sendCrm'), 1);
    assert.equal(count('sendNotion'), 2);
    assert.equal((src.match(/sendNotion\(meetingId, \{ includeTranscript, startOver: true \}\)/g) || []).length, 1);
});

test('Salesforce is wired end to end as a fourth CRM (parity round 3)', () => {
    // Type: part of the CRM union.
    assert.match(read('src/types/meetingOutputs.ts'), /export type CrmService = [^;]*'salesforce'/);
    // Sender: label, instance-URL guard, SOQL lookup and Task send.
    const crm = read('electron/services/outputs/crm.ts');
    assert.match(crm, /CRM_LABELS[^=]*=\s*\{[^}]*salesforce: 'Salesforce'/);
    assert.match(crm, /export function normaliseSalesforceInstanceUrl/);
    assert.match(crm, /FROM Contact WHERE Email/);
    assert.match(crm, /\/sobjects\/Task/);
    // Main: a recognised token service and CRM.
    const ipc = read('electron/services/outputs/outputsIpc.ts');
    assert.match(ipc, /TOKEN_SERVICES = \[[^\]]*'salesforce'/);
    assert.match(ipc, /isCrm[^=]*=.*'salesforce'/);
    // UI: a Settings row and a place in the Share menu's CRM picker.
    // Every CRM has a page on Settings › Connectors; its top is the shared TokenServicePanel.
    assert.match(read('src/components/settings/connectors/catalog.ts'), /key: 'salesforce'/);
    assert.match(read('src/components/settings/ConnectionsSettings.tsx'), /<TokenServicePanel\s+service=\{svc\}/);
    const share = read('src/components/meeting/ShareMenu.tsx');
    assert.match(share, /CRM_NAMES[^=]*=\s*\{[^}]*salesforce: 'Salesforce'/);
    assert.match(share, /'hubspot', 'attio', 'affinity', 'salesforce'/);
});

test('Connectors: the MCP card is Granola\'s layout, with a setup for every app main writes one for', () => {
    const pane = read('src/components/settings/ConnectionsSettings.tsx');
    const card = read('src/components/settings/connectors/McpCard.tsx');
    // The pane hands the card the status; the card owns the switch and the setups.
    assert.match(pane, /<McpCard mcp=\{status\.mcp\} onStatus=/);
    assert.doesNotMatch(pane, /McpRow/);
    assert.match(card, /setMcpEnabled\(!mcp\.enabled\)/);
    assert.match(card, /resetMcpToken\(\)/);
    // Every snippet main returns has a tab, and no tab points at a missing snippet.
    const types = read('src/types/meetingOutputs.ts');
    const keys = types.match(/snippets\?: \{([^}]*)\}/)[1].match(/(\w+): string/g).map((s) => s.split(':')[0]).sort();
    const tabs = [...card.matchAll(/\{ id: '(\w+)', label: /g)].map((m) => m[1]).sort();
    assert.deepEqual(tabs, keys);
    // Claude, OpenAI and code tiles stack at rest and spread on hover, as Granola's do.
    assert.match(card, /claude\.svg\?raw/);
    assert.match(card, /openai\.svg\?raw/);
    // Granola's stack: they overlap at rest, each later tile on top (no z-index
    // reversing the row), and spread apart on hover, each one step further.
    assert.equal((card.match(/-ml-2 /g) || []).length, 2);
    assert.doesNotMatch(card, /<Tile className="z-/);
    assert.match(card, /group-hover:translate-x-3/);
    assert.match(card, /group-hover:translate-x-6/);
    // A new token cuts off every connected app, so it takes a second press.
    assert.match(card, /Disconnect every app\?/);
});

test('Connectors: the MCP heading\'s IBM Plex Serif ships with the app, with its licence', () => {
    const css = read('src/index.css');
    const files = [...css.matchAll(/url\('\.\/(font\/IBMPlexSerif\/[^']+\.woff2)'\)/g)].map((m) => m[1]);
    assert.equal(files.length, 2);
    for (const f of files) assert.ok(existsSync(resolve(ROOT, 'src', f)), `${f} missing`);
    assert.ok(existsSync(resolve(ROOT, 'src/font/IBMPlexSerif/LICENSE-OFL.txt')));
    assert.match(read('tailwind.config.js'), /"plex-serif": \['"IBM Plex Serif"'/);
    assert.match(read('src/components/settings/connectors/McpCard.tsx'), /font-plex-serif text-2xl/);
});

test("Connectors: the Gmail page is Granola's layout (action, rule, Includes cards, How Gmail is used)", () => {
    const parts = read('src/components/settings/connectors/parts.tsx');
    const gmail = read('src/components/settings/connectors/GmailPanel.tsx');
    const pane = read('src/components/settings/ConnectionsSettings.tsx');
    // Header: logo in a 56px tile, name in the display serif.
    assert.match(parts, /h-14 w-14 shrink-0 items-center justify-center rounded-xl/);
    assert.match(parts, /<h3 className="font-plex-serif text-2xl leading-7/);
    // Connected opens on hover to a disconnect that asks once.
    assert.match(parts, /grid-cols-\[max-content_0fr\] hover:grid-cols-\[max-content_1fr\]/);
    assert.match(gmail, /<ConnectedPill confirmLabel=\{t\('Disconnect Gmail\?'\)\}/);
    assert.match(gmail, /<ConnectPill label=\{t\('Connect Gmail'\)\} external/);
    assert.equal((gmail.match(/<FeatureCard\b/g) || []).length, 2);
    assert.match(gmail, /<UsageList title="How Gmail is used"/);
    // The briefs switch lives on its card; the generic How it works is not repeated.
    assert.match(gmail, /setGmailBriefsEnabled\(!status\.briefsEnabled\)/);
    assert.match(pane, /\{page !== 'gmail' && <HowItWorks lines=\{entry\.howItWorks\} \/>\}/);
    // The MCP card and Gmail share one glass pill.
    assert.match(read('src/components/settings/connectors/McpCard.tsx'), /className=\{GLASS_PILL_CLASS\}/);
});

test("Connectors: every other page is Granola's too (pill, rule, sections, How it works)", () => {
    const parts = read('src/components/settings/connectors/parts.tsx');
    const pane = read('src/components/settings/ConnectionsSettings.tsx');
    const hooks = read('src/components/settings/connectors/WebhooksPanel.tsx');
    // One action row: the pill, a quiet status, quiet buttons, what opens under, then the rule.
    assert.match(parts, /export const ActionArea/);
    assert.match(parts, /mb-6 mt-3 h-px w-full bg-border-muted/);
    // Token services and Slack sit on it; Connect says the service's name, with the browser arrow when it signs in there.
    assert.match(pane, /<ConnectPill label=\{t\(`Connect \$\{meta\.title\}`\)\} external/);
    assert.match(pane, /confirmLabel=\{t\(`Disconnect \$\{meta\.title\}\?`\)\}/);
    assert.match(pane, /<ConnectPill label=\{t\('Connect Slack'\)\} external/);
    assert.match(pane, /<DetailSection title="Where pages go">/);
    // Zapier and Webhooks add from the pill; Zapier also opens Zapier's editor in the browser.
    assert.match(hooks, /<ConnectPill\s+label=\{zapier \? t\('Add a Zap'\) : t\('Add webhook'\)\}/);
    assert.match(hooks, /openExternal\?\.\('https:\/\/zapier\.com\/editor'\)/);
    // Automation shows only once there is something to send to.
    assert.match(read('src/components/settings/connectors/AutoSendSection.tsx'), /if \(!connected && !mine\.length\) return null;/);
});

test('Connectors: Salesforce, HubSpot and Pipedrive always offer the pasted token beside browser sign-in', () => {
    const pane = read('src/components/settings/ConnectionsSettings.tsx');
    assert.match(pane, /TOKEN_ALWAYS_OFFERED: ReadonlySet<string> = new Set\(\['salesforce', 'hubspot', 'pipedrive'\]\)/);
    // A quiet button beside Connect opens the token form; the after-failure link is for the others only.
    assert.match(pane, /useBrowser && !open && TOKEN_ALWAYS_OFFERED\.has\(service\) \?/);
    assert.match(pane, /signIn\.failed && !open && !TOKEN_ALWAYS_OFFERED\.has\(service\)/);
});
