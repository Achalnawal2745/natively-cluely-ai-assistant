// Settings › Connectors: Gmail, where meeting notes can be sent (Slack, Notion,
// Zapier, webhooks and five CRMs), personal API keys for the local API, and the
// local MCP server that lets AI apps on this computer read meetings. Each
// connector has its own page (src/components/settings/connectors/).
// Follow-ups in the user's own style live in each mode's editor ("Follow-ups in
// your style", above Notes template), not here.
//
// Built from General's parts, as Intelligence is (SettingsRow, section heading,
// secondary button, Audio's card for anything that opens under a row, the
// Liquid Glass action button for the one primary action). Tokens are sent to
// the main process once, to be checked and saved in the system keychain; this
// pane only ever reads back whether one is saved.

import React, { useCallback, useEffect, useState } from 'react';
import {
    AlertCircle, KeyRound, Plus, RefreshCw, Search, Trash2,
} from 'lucide-react';
import { useT } from '../../i18n';
import { ConnectorMark } from './ConnectorMark';
import { BusyIcon, FlashNotice, flashOf, type Flash } from './connectors/common';
import { CONNECTOR_CATALOG, catalogEntry, type ConnectorKey } from './connectors/catalog';
import { ActionArea, ConnectPill, ConnectedPill, DetailHeader, DetailSection, GroupLabel, HowItWorks, ListCard, ListRow, QUIET_BTN } from './connectors/parts';
import { AutoSendSection } from './connectors/AutoSendSection';
import { WebhooksPanel } from './connectors/WebhooksPanel';
import { GmailPanel } from './connectors/GmailPanel';
import { McpCard } from './connectors/McpCard';
import type { AutoSendDestination, AutoSendRuleInfo, ConnectorsApi, FolderOption, GmailStatus, WebhookEndpointInfo } from '../../types/connectors';
import {
    Collapse, SETTINGS_BTN, SETTINGS_CARD, SETTINGS_FIELD_LABEL, SETTINGS_INPUT,
    SettingsFootnote, SettingsMotionReady, SettingsNotice, SettingsSectionHeading,
    useMotionReadyAfter, useSettingsTones,
} from './SettingsRow';
import type {
    ConnectionsStatus, CrmService, EnrichmentService, MeetingOutputsApi, NotionSearchResult, OAuthConnectorService,
} from '../../types/meetingOutputs';

const api = (): MeetingOutputsApi | undefined => window.electronAPI?.meetingOutputs;

/**
 * Connect by signing in with the service's own account, in the browser
 * (Settings › Connectors). Resolves when the browser hands back, the person
 * cancels, or it fails; a failure offers the pasted-token form instead.
 */
function useBrowserConnect(service: OAuthConnectorService, onConnected: () => void) {
    const t = useT();
    const [waiting, setWaiting] = useState(false);
    const [failed, setFailed] = useState(false);
    const [flash, setFlash] = useState<Flash>(null);
    const start = async () => {
        setWaiting(true);
        setFailed(false);
        setFlash(null);
        const res = await api()?.connectWithBrowser(service).catch(() => undefined);
        setWaiting(false);
        if (res?.ok) { setFlash(flashOf(res)); onConnected(); return; }
        // Cancelled: nothing to say.
        if (res && !res.message) return;
        setFailed(true);
        setFlash(flashOf(res, undefined) ?? { tone: 'danger', text: t('Something went wrong. Try again.') });
    };
    const cancel = () => { void api()?.cancelBrowserConnect(); };
    return { waiting, failed, flash, start, cancel, clearFlash: () => { setFlash(null); setFailed(false); } };
}

/** "Use a token instead": shown under a row only after a browser sign-in did not work. */
const TokenFallbackLink: React.FC<{ label: string; open: boolean; onToggle: () => void }> = ({ label, open, onToggle }) => (
    <div className="pb-3">
        <button type="button" className="text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline" aria-expanded={open} onClick={onToggle}>
            {label}
        </button>
    </div>
);


// ── Token services: Notion and the CRMs ──────────────────────────────────

/**
 * CRMs whose page always offers the pasted token beside browser sign-in, not
 * only after a sign-in fails: Salesforce's sign-in reaches only the org its
 * app lives in until it is packaged, and HubSpot and Pipedrive have no app yet
 * (they open the token form directly until natively-api has their clients).
 */
const TOKEN_ALWAYS_OFFERED: ReadonlySet<string> = new Set(['salesforce', 'hubspot', 'pipedrive']);

const TOKEN_META: Record<'notion' | CrmService | EnrichmentService, { title: string; icon: React.ReactNode; blurb: string; tokenLabel: string; howTo: string }> = {
    notion: {
        title: 'Notion',
        icon: <ConnectorMark id="notion" />,
        blurb: 'Turn meeting notes into Notion pages.',
        tokenLabel: 'Integration token',
        howTo: 'In Notion, open Settings, Connections, Develop or manage integrations, and create an internal integration. Copy its token here, then share the page or database you want notes in with that integration.',
    },
    hubspot: {
        title: 'HubSpot',
        icon: <ConnectorMark id="hubspot" />,
        blurb: 'Add meeting notes to the contacts you met.',
        tokenLabel: 'Private app token',
        howTo: 'In HubSpot, open Settings, Integrations, Private Apps, and create an app with the contacts read and notes write scopes. Copy its access token here.',
    },
    attio: {
        title: 'Attio',
        icon: <ConnectorMark id="attio" />,
        blurb: 'Add meeting notes to the people you met.',
        tokenLabel: 'API key',
        howTo: 'In Attio, open Workspace settings, Developers, and create an access token that can read records and write notes. Copy it here.',
    },
    affinity: {
        title: 'Affinity',
        icon: <ConnectorMark id="affinity" />,
        blurb: 'Add meeting notes to the people you met.',
        tokenLabel: 'API key',
        howTo: 'In Affinity, open Settings, API, and generate an API key. Copy it here.',
    },
    salesforce: {
        title: 'Salesforce',
        icon: <ConnectorMark id="salesforce" />,
        blurb: 'Log meetings on the contacts you met.',
        tokenLabel: 'Access token',
        howTo: 'Paste your Salesforce access token and your instance URL (from the Salesforce CLI, "sf org display", or a connected app). Access tokens expire, so paste a fresh one when logging stops working.',
    },
    pipedrive: {
        title: 'Pipedrive',
        icon: <ConnectorMark id="pipedrive" />,
        blurb: 'Add meeting notes to the people you met.',
        tokenLabel: 'API token',
        howTo: 'In Pipedrive, open your profile menu, Personal preferences, API, and copy your personal API token here.',
    },
    clearbit: {
        title: 'Clearbit',
        icon: <ConnectorMark id="clearbit" />,
        blurb: 'Suggest a title and company for the people you met, looked up by email.',
        tokenLabel: 'API key',
        howTo: 'In Clearbit, open your account settings and copy the secret API key. Natively looks people up only when you press "Look up attendees" on a meeting, and every result is a suggestion you accept on the People page.',
    },
};

/**
 * A token service's page top (Notion, the CRMs, Clearbit), on Granola's: the
 * glass "Connect HubSpot" pill (with the browser arrow when it signs in there),
 * or "Connected to Acme" that opens to disconnect, with Test connection beside
 * it. The pasted-token form opens under the pill when there is no browser
 * sign-in, or after one did not work. `children` are the page's sections.
 */
const TokenServicePanel: React.FC<{
    service: 'notion' | CrmService | EnrichmentService;
    connected: boolean;
    /** The workspace or account a browser sign-in connected, for "Connected to …". */
    account?: string;
    /** True when Connect signs in with the browser instead of opening the token form. */
    browser?: boolean;
    notice?: React.ReactNode;
    onChanged: () => void;
    children?: React.ReactNode;
}> = ({ service, connected, account, browser, notice, onChanged, children }) => {
    const t = useT();
    const meta = TOKEN_META[service];
    const signIn = useBrowserConnect(service as OAuthConnectorService, onChanged);
    const useBrowser = !!browser && !connected;
    const needsUrl = service === 'salesforce';
    const [open, setOpen] = useState(false);
    const [token, setToken] = useState('');
    const [instanceUrl, setInstanceUrl] = useState('');
    const [busy, setBusy] = useState<'save' | 'test' | null>(null);
    const [flash, setFlash] = useState<Flash>(null);
    const canSave = !!token.trim() && (!needsUrl || !!instanceUrl.trim()) && !busy;

    const save = async () => {
        if (!canSave) return;
        setBusy('save');
        setFlash(null);
        const res = await api()?.saveToken(service, token, needsUrl ? instanceUrl.trim() : undefined).catch(() => undefined);
        setBusy(null);
        setFlash(flashOf(res, `${meta.title} is connected.`));
        if (res?.ok) { setToken(''); setInstanceUrl(''); setOpen(false); onChanged(); }
    };
    const test = async () => {
        setBusy('test');
        setFlash(null);
        const res = await api()?.testConnection(service).catch(() => undefined);
        setBusy(null);
        setFlash(flashOf(res));
    };
    const tokenInstead = t(`Use ${/^[aeiou]/i.test(meta.tokenLabel) ? 'an' : 'a'} ${meta.tokenLabel.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())} instead`);
    const disconnect = async () => {
        await api()?.disconnect(service).catch(() => undefined);
        setFlash(null);
        signIn.clearFlash();
        onChanged();
    };

    const pill = connected ? (
        <ConnectedPill
            label={account ? `${t('Connected to')} ${account}` : t('Connected')}
            confirmLabel={t(`Disconnect ${meta.title}?`)}
            onDisconnect={() => void disconnect()}
        />
    ) : useBrowser && !open ? (
        <ConnectPill label={t(`Connect ${meta.title}`)} external waiting={signIn.waiting} onClick={() => void signIn.start()} />
    ) : (
        <ConnectPill label={open ? t('Cancel') : t(`Connect ${meta.title}`)} expanded={open} onClick={() => setOpen((v) => !v)} />
    );
    const secondary = signIn.waiting ? (
        <button type="button" className={QUIET_BTN} onClick={signIn.cancel}>{t('Cancel')}</button>
    ) : connected ? (
        <button type="button" className={QUIET_BTN} onClick={() => void test()} disabled={!!busy}>
            <BusyIcon busy={busy === 'test'} icon={<RefreshCw size={12} />} />
            {t('Test connection')}
        </button>
    ) : useBrowser && !open && TOKEN_ALWAYS_OFFERED.has(service) ? (
        <button type="button" className={QUIET_BTN} aria-expanded={false} onClick={() => { signIn.clearFlash(); setOpen(true); }}>
            <KeyRound size={12} />
            {tokenInstead}
        </button>
    ) : undefined;

    return (
        <>
            {notice}
            <ActionArea
                note={signIn.waiting ? t(`Finish signing in to ${meta.title} in your browser.`) : undefined}
                secondary={secondary}
                below={
                    <>
                        <FlashNotice flash={flash ?? signIn.flash} />
                        {useBrowser && signIn.failed && !open && !TOKEN_ALWAYS_OFFERED.has(service) && (
                            <TokenFallbackLink label={tokenInstead} open={open} onToggle={() => setOpen(true)} />
                        )}
                        <Collapse open={open && !connected}>
                            <div className="pb-1">
                                <div className={`${SETTINGS_CARD} p-4 space-y-3`}>
                                    <p className="text-xs leading-relaxed text-text-secondary">{t(meta.howTo)}</p>
                                    {needsUrl && (
                                        <label className="block">
                                            <span className={SETTINGS_FIELD_LABEL}>{t('Instance URL')}</span>
                                            <input
                                                type="text"
                                                autoComplete="off"
                                                spellCheck={false}
                                                placeholder="https://yourorg.my.salesforce.com"
                                                className={`${SETTINGS_INPUT} mt-1`}
                                                value={instanceUrl}
                                                onChange={(e) => setInstanceUrl(e.target.value)}
                                                onKeyDown={(e) => { if (e.key === 'Enter' && canSave) void save(); }}
                                            />
                                        </label>
                                    )}
                                    <label className="block">
                                        <span className={SETTINGS_FIELD_LABEL}>{t(meta.tokenLabel)}</span>
                                        <div className="mt-1 flex items-center gap-2">
                                            <input
                                                type="password"
                                                autoComplete="off"
                                                spellCheck={false}
                                                className={SETTINGS_INPUT}
                                                value={token}
                                                onChange={(e) => setToken(e.target.value)}
                                                onKeyDown={(e) => { if (e.key === 'Enter' && canSave) void save(); }}
                                            />
                                            <button type="button" className={SETTINGS_BTN} onClick={() => void save()} disabled={!canSave}>
                                                <BusyIcon busy={busy === 'save'} icon={<KeyRound size={14} />} />
                                                {t('Save')}
                                            </button>
                                        </div>
                                    </label>
                                    <p className="text-xs text-text-tertiary">{t('Natively checks the token before saving it, and keeps it in your system keychain.')}</p>
                                </div>
                            </div>
                        </Collapse>
                    </>
                }
            >
                {pill}
            </ActionArea>
            {children}
        </>
    );
};

/** Where new Notion pages go: search the pages and databases shared with the integration. */
const NotionParentPicker: React.FC<{ current?: { title: string; type: string }; onPicked: () => void }> = ({ current, onPicked }) => {
    const t = useT();
    const [open, setOpen] = useState(!current);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<NotionSearchResult[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [flash, setFlash] = useState<Flash>(null);

    const search = async () => {
        setBusy(true);
        setFlash(null);
        const res = await api()?.searchNotion(query).catch(() => undefined);
        setBusy(false);
        if (!res?.ok) { setFlash(flashOf(res)); setResults(null); return; }
        setResults(res.results || []);
        if (!res.results?.length) setFlash({ tone: 'warn', text: t('Nothing found. In Notion, share the page or database with your integration, then search again.') });
    };
    useEffect(() => { if (open && results === null) void search(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    const pick = async (r: NotionSearchResult) => {
        const res = await api()?.setNotionParent(r).catch(() => undefined);
        if (!res?.ok) { setFlash(flashOf(res)); return; }
        setOpen(false);
        setFlash(null);
        onPicked();
    };

    return (
        <div>
            <div className={`${SETTINGS_CARD} flex items-center gap-3 px-4 py-3`}>
                <ConnectorMark id="notion" size={18} />
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                    {current ? current.title : <span className="text-text-secondary">{t('Pick where new pages go.')}</span>}
                </span>
                {current && <span className="shrink-0 text-xs text-text-tertiary">{current.type === 'database' ? t('Database') : t('Page')}</span>}
                <button type="button" className={QUIET_BTN} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                    {open ? t('Done') : current ? t('Change') : t('Pick')}
                </button>
            </div>
            <Collapse open={open}>
                <div className="pt-3">
                    <div className={`${SETTINGS_CARD} p-3 space-y-2`}>
                        <div className="flex items-center gap-2">
                            <input
                                className={SETTINGS_INPUT}
                                placeholder={t('Search pages and databases')}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
                            />
                            <button type="button" className={SETTINGS_BTN} onClick={() => void search()} disabled={busy}>
                                <BusyIcon busy={busy} icon={<Search size={14} />} />
                                {t('Search')}
                            </button>
                        </div>
                        <FlashNotice flash={flash} />
                        {results && results.length > 0 && (
                            <ul className="max-h-56 overflow-y-auto divide-y divide-border-subtle">
                                {results.map((r) => (
                                    <li key={r.id}>
                                        <button type="button" onClick={() => void pick(r)} className="w-full flex items-center justify-between gap-3 px-2 py-2 text-left text-xs text-text-primary hover:bg-bg-elevated rounded-md transition-colors">
                                            <span className="min-w-0 truncate">{r.title}</span>
                                            <span className="shrink-0 text-text-tertiary">{r.type === 'database' ? t('Database') : t('Page')}</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </Collapse>
        </div>
    );
};

// ── Slack ────────────────────────────────────────────────────────────────

/**
 * Slack's page top: "Connect Slack" (Slack asks for the channel on its own
 * screen), then, once a channel is in, "Connected" with Add channel beside it.
 * The webhook form opens under the pill when there is no browser sign-in, or
 * after one did not work. The channels are their own section below the rule.
 */
const SlackPanel: React.FC<{ webhooks: ConnectionsStatus['slack']['webhooks']; browser?: boolean; notice?: React.ReactNode; onChanged: () => void; children?: React.ReactNode }> = ({ webhooks, browser, notice, onChanged, children }) => {
    const t = useT();
    const [open, setOpen] = useState(false);
    // Signing in with Slack adds one channel: Slack asks which on its own screen.
    const signIn = useBrowserConnect('slack', onChanged);
    const useBrowser = !!browser && !open;
    const [label, setLabel] = useState('');
    const [url, setUrl] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [flash, setFlash] = useState<Flash>(null);
    const n = webhooks.length;

    const add = async () => {
        setBusy('add');
        setFlash(null);
        const res = await api()?.addSlackWebhook(label, url).catch(() => undefined);
        setBusy(null);
        setFlash(flashOf(res, t('Slack channel added.')));
        if (res?.ok) { setLabel(''); setUrl(''); setOpen(false); onChanged(); }
    };
    const test = async (id: string) => {
        setBusy(id);
        setFlash(null);
        const res = await api()?.testSlackWebhook(id).catch(() => undefined);
        setBusy(null);
        setFlash(flashOf(res));
    };
    const remove = async (id: string) => {
        await api()?.removeSlackWebhook(id).catch(() => undefined);
        setFlash(null);
        onChanged();
    };
    const addChannel = () => (useBrowser ? void signIn.start() : setOpen((v) => !v));

    const pill = n ? (
        <ConnectedPill label={n === 1 ? t('Connected · 1 channel') : `${t('Connected')} · ${n} ${t('channels')}`} />
    ) : useBrowser ? (
        <ConnectPill label={t('Connect Slack')} external waiting={signIn.waiting} onClick={() => void signIn.start()} />
    ) : (
        <ConnectPill label={open ? t('Cancel') : t('Connect Slack')} expanded={open} onClick={() => setOpen((v) => !v)} />
    );
    const secondary = signIn.waiting ? (
        <button type="button" className={QUIET_BTN} onClick={signIn.cancel}>{t('Cancel')}</button>
    ) : n ? (
        <button type="button" className={QUIET_BTN} onClick={addChannel} aria-expanded={useBrowser ? undefined : open}>
            {useBrowser || !open ? <Plus size={12} /> : null}
            {!useBrowser && open ? t('Cancel') : t('Add channel')}
        </button>
    ) : undefined;

    return (
        <>
            {notice}
            <ActionArea
                note={signIn.waiting ? t('Pick a channel in your browser to finish.') : undefined}
                secondary={secondary}
                below={
                    <>
                        <FlashNotice flash={flash ?? signIn.flash} />
                        {useBrowser && signIn.failed && (
                            <TokenFallbackLink label={t('Paste a webhook address instead')} open={open} onToggle={() => setOpen(true)} />
                        )}
                        <Collapse open={open}>
                            <div className="pb-1">
                                <div className={`${SETTINGS_CARD} p-4 space-y-3`}>
                                    <p className="text-xs leading-relaxed text-text-secondary">
                                        {t('In Slack, create an app for your workspace, turn on Incoming Webhooks, and add a webhook for the channel. Paste its address here. Add one per channel.')}
                                    </p>
                                    <label className="block">
                                        <span className={SETTINGS_FIELD_LABEL}>{t('Channel name')}</span>
                                        <input className={`${SETTINGS_INPUT} mt-1`} placeholder="#team-updates" value={label} onChange={(e) => setLabel(e.target.value)} />
                                    </label>
                                    <label className="block">
                                        <span className={SETTINGS_FIELD_LABEL}>{t('Webhook address')}</span>
                                        <input
                                            type="password"
                                            autoComplete="off"
                                            spellCheck={false}
                                            className={`${SETTINGS_INPUT} mt-1`}
                                            placeholder="https://hooks.slack.com/services/…"
                                            value={url}
                                            onChange={(e) => setUrl(e.target.value)}
                                        />
                                    </label>
                                    <div className="flex justify-end">
                                        <button type="button" className={SETTINGS_BTN} onClick={() => void add()} disabled={!url.trim() || !label.trim() || !!busy}>
                                            <BusyIcon busy={busy === 'add'} icon={<Plus size={14} />} />
                                            {t('Add channel')}
                                        </button>
                                    </div>
                                    <p className="text-xs text-text-tertiary">{t('Natively checks the webhook without posting anything, and keeps it in your system keychain.')}</p>
                                </div>
                            </div>
                        </Collapse>
                    </>
                }
            >
                {pill}
            </ActionArea>
            {n > 0 && (
                <DetailSection title="Channels">
                    <ListCard>
                        {webhooks.map((w) => (
                            <div key={w.id} className="flex items-center gap-3 px-4 py-3">
                                <ConnectorMark id="slack" size={18} />
                                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{w.label}</span>
                                <button type="button" className={QUIET_BTN} onClick={() => void test(w.id)} disabled={!!busy}>
                                    <BusyIcon busy={busy === w.id} icon={<RefreshCw size={12} />} />
                                    {t('Test')}
                                </button>
                                <button type="button" className={QUIET_BTN} onClick={() => void remove(w.id)} aria-label={`${t('Remove')} ${w.label}`}>
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        ))}
                    </ListCard>
                </DetailSection>
            )}
            {children}
        </>
    );
};

// ── Pane ─────────────────────────────────────────────────────────────────
//
// Laid out like Granola's Connectors: Integrations and MCP, each a rounded
// card of rows (logo, name, what it does, "Connected", chevron). A row opens its
// page, with the way back at the top; the list is where everything is found,
// the page is where it is set up.

const capi = (): ConnectorsApi | undefined => window.electronAPI?.connectors;

type ConnectorsData = {
    webhooks: WebhookEndpointInfo[];
    rules: AutoSendRuleInfo[];
    folders: FolderOption[];
    gmail: GmailStatus | null;
    available: boolean;
};

const EMPTY: ConnectorsData = { webhooks: [], rules: [], folders: [], gmail: null, available: false };

async function loadConnectorsData(): Promise<ConnectorsData> {
    const c = capi();
    if (!c) return EMPTY;
    const safe = <T,>(p: Promise<T> | undefined, fallback: T): Promise<T> => (p ? p.catch(() => fallback) : Promise.resolve(fallback));
    const [webhooks, rules, folders, gmail] = await Promise.all([
        safe(c.listWebhooks?.(), [] as WebhookEndpointInfo[]),
        safe(c.listAutoSendRules?.(), [] as AutoSendRuleInfo[]),
        safe(c.listFolders?.(), [] as FolderOption[]),
        safe(c.getGmailStatus?.(), null as GmailStatus | null),
    ]);
    return { webhooks, rules, folders, gmail, available: true };
}

export const ConnectionsSettings: React.FC = () => {
    const t = useT();
    const tones = useSettingsTones();
    const [status, setStatus] = useState<ConnectionsStatus | null>(null);
    const [data, setData] = useState<ConnectorsData>(EMPTY);
    const [page, setPage] = useState<ConnectorKey | null>(null);
    // Which services sign in with the browser; until natively-api answers, the token forms.
    const [browser, setBrowser] = useState<Partial<Record<OAuthConnectorService, boolean>>>({});
    const load = useCallback(async () => {
        const [s, d] = await Promise.all([api()?.getConnections().catch(() => null), loadConnectorsData()]);
        if (s) setStatus(s);
        setData(d);
    }, []);
    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        let live = true;
        // Optional call: a renderer newer than its preload (dev reload) has no such method.
        void api()?.oauthServices?.().then((b) => { if (live && b) setBrowser(b); }).catch(() => {});
        return () => { live = false; };
    }, []);
    const motionReady = useMotionReadyAfter(!!status);
    if (!status) return null;
    const reload = () => void load();

    const isConnected = (key: ConnectorKey): boolean => {
        switch (key) {
            case 'gmail': return !!data.gmail?.connected;
            case 'slack': return status.slack.webhooks.length > 0;
            case 'zapier': return data.webhooks.some((w) => w.kind === 'zapier');
            case 'webhooks': return data.webhooks.some((w) => w.kind === 'webhook');
            default: return !!status[key]?.connected;
        }
    };
    const rowStatus = (key: ConnectorKey): string | undefined => {
        if (!isConnected(key)) return undefined;
        if (key === 'slack') return status.slack.webhooks.length === 1 ? t('1 channel') : `${status.slack.webhooks.length} ${t('channels')}`;
        if (key === 'zapier' || key === 'webhooks') {
            const n = data.webhooks.filter((w) => w.kind === (key === 'zapier' ? 'zapier' : 'webhook')).length;
            return key === 'zapier' ? (n === 1 ? t('1 Zap') : `${n} ${t('Zaps')}`) : (n === 1 ? t('1 endpoint') : `${n} ${t('endpoints')}`);
        }
        return t('Connected');
    };

    const storageNotice = !status.secureStorage && (
        <SettingsNotice tone={tones.warn} icon={<AlertCircle size={14} />}>
            {t('This computer has no secure storage available, so connections are kept until Natively quits.')}
        </SettingsNotice>
    );

    // ── A connector's page ──
    if (page) {
        const back = () => { setPage(null); reload(); };
        const entry = catalogEntry(page);
        const connected = isConnected(page);
        let body: React.ReactNode;
        if (page === 'gmail') {
            body = <GmailPanel status={data.gmail} onStatus={(g) => setData((d) => ({ ...d, gmail: g }))} onChanged={reload} />;
        } else if (page === 'zapier' || page === 'webhooks') {
            body = <WebhooksPanel kind={page === 'zapier' ? 'zapier' : 'webhook'} endpoints={data.webhooks} folders={data.folders} available={data.available} onChanged={reload} />;
        } else if (page === 'slack') {
            body = (
                <SlackPanel webhooks={status.slack.webhooks} browser={browser.slack} notice={storageNotice} onChanged={reload}>
                    <AutoSendSection
                        destinations={status.slack.webhooks.map((w) => ({ destination: { kind: 'slack', webhookId: w.id } as AutoSendDestination, label: w.label }))}
                        connected={connected}
                        rules={data.rules}
                        folders={data.folders}
                        onChanged={reload}
                    />
                </SlackPanel>
            );
        } else {
            const svc = page as 'notion' | CrmService | 'clearbit';
            const account = svc === 'notion' || svc === 'hubspot' || svc === 'attio' || svc === 'salesforce' || svc === 'pipedrive' ? status[svc].account : undefined;
            const oauth = svc === 'notion' || svc === 'hubspot' || svc === 'attio' || svc === 'salesforce' || svc === 'pipedrive' ? browser[svc] : undefined;
            body = (
                <TokenServicePanel
                    service={svc}
                    connected={connected}
                    account={account}
                    browser={oauth}
                    notice={storageNotice}
                    onChanged={reload}
                >
                    {svc === 'notion' && status.notion.connected && (
                        <DetailSection title="Where pages go">
                            <NotionParentPicker current={status.notion.parent} onPicked={reload} />
                        </DetailSection>
                    )}
                    {svc !== 'clearbit' && (
                        <AutoSendSection
                            destinations={[{
                                destination: svc === 'notion' ? { kind: 'notion' } : { kind: 'crm', service: svc as CrmService },
                                label: entry.title,
                            }]}
                            connected={connected && (svc !== 'notion' || !!status.notion.parent)}
                            rules={data.rules}
                            folders={data.folders}
                            onChanged={reload}
                        />
                    )}
                </TokenServicePanel>
            );
        }
        return (
            <SettingsMotionReady.Provider value={motionReady}>
                <div className="animated fadeIn" key={page}>
                    <DetailHeader icon={<ConnectorMark id={entry.mark} size={28} />} title={entry.title} description={entry.description} onBack={back} />
                    {body}
                    {/* Gmail says how it is used in its own section, as Granola's page does. */}
                    {page !== 'gmail' && <HowItWorks lines={entry.howItWorks} />}
                    {page !== 'gmail' && page !== 'zapier' && page !== 'webhooks' && (
                        <SettingsFootnote icon={<KeyRound size={14} />}>
                            {t('Tokens and webhook addresses are kept in your system keychain and never shown again.')}
                        </SettingsFootnote>
                    )}
                </div>
            </SettingsMotionReady.Provider>
        );
    }

    // ── The list ──
    return (
        <SettingsMotionReady.Provider value={motionReady}>
            <div className="space-y-8 animated fadeIn" data-settings-stagger>
                <section>
                    <SettingsSectionHeading
                        title={t('Connectors')}
                        subtitle={t('Connect Natively to the tools you use. Meeting notes stay on this computer until you send them, or until a rule you made sends them.')}
                    />
                    {storageNotice}
                    <GroupLabel>{t('Integrations')}</GroupLabel>
                    <ListCard>
                        {CONNECTOR_CATALOG.map((e) => (
                            <ListRow
                                key={e.key}
                                icon={<ConnectorMark id={e.mark} size={28} />}
                                title={t(e.title)}
                                description={t(e.description)}
                                status={rowStatus(e.key)}
                                onOpen={() => setPage(e.key)}
                            />
                        ))}
                    </ListCard>
                </section>

                <section>
                    <GroupLabel>{t('MCP')}</GroupLabel>
                    <McpCard mcp={status.mcp} onStatus={(mcp) => setStatus((s) => (s ? { ...s, mcp } : s))} />
                </section>
            </div>
        </SettingsMotionReady.Provider>
    );
};

export default ConnectionsSettings;
