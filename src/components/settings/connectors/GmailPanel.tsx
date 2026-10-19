// Gmail: sign in with Google so meeting briefs can mention recent email threads
// with the people you are meeting, and follow-ups can be sent from your own
// Gmail. Tokens stay on this computer; Natively calls Google directly.
//
// Laid out as Granola's Gmail page: the one action under the header, a rule,
// what connecting includes, then how Gmail is used. Granola's copy promises a
// server that drafts and sends; these lines say what Natively does instead.

import React, { useState } from 'react';
import { AlertCircle, ExternalLink, Lock, Mail, Send } from 'lucide-react';
import { useT } from '../../../i18n';
import { SettingsNotice, SettingsSwitch, useSettingsTones } from '../SettingsRow';
import type { ConnectorsApi, GmailStatus } from '../../../types/connectors';
import { FlashNotice, flashOf, type Flash } from './common';
import { ActionArea, ConnectPill, ConnectedPill, FeatureCard, GroupLabel, QUIET_BTN, UsageList } from './parts';

const capi = (): ConnectorsApi | undefined => window.electronAPI?.connectors;

const USAGE = [
    { icon: <Mail size={16} />, text: 'Natively reads only your threads with the people in your meetings, to write their briefs.' },
    { icon: <Send size={16} />, text: 'Nothing is sent until you press Send with Gmail and confirm.' },
    { icon: <Lock size={16} />, text: 'Your Google sign-in stays on this computer. Natively talks to Google directly, never through our servers.' },
    { icon: <ExternalLink size={16} />, text: 'Pressing Connect opens Google in your browser to confirm permissions.' },
];

export const GmailPanel: React.FC<{ status: GmailStatus | null; onStatus: (s: GmailStatus) => void; onChanged: () => void }> = ({ status, onStatus, onChanged }) => {
    const t = useT();
    const tones = useSettingsTones();
    const [waiting, setWaiting] = useState(false);
    const [flash, setFlash] = useState<Flash>(null);

    const connect = async () => {
        setWaiting(true);
        setFlash(null);
        const res = await capi()?.connectGmail().catch(() => undefined);
        setWaiting(false);
        if (res && !res.ok && !res.message) return; // cancelled
        setFlash(flashOf(res, t('Gmail is connected.')));
        onChanged();
    };
    const disconnect = async () => {
        const res = await capi()?.disconnectGmail().catch(() => undefined);
        setFlash(res?.ok ? null : flashOf(res));
        onChanged();
    };

    if (!status) return null;
    const available = status.available;
    const note = waiting
        ? t('Finish signing in to Google in your browser.')
        : status.connected ? (status.account || t('your Google account')) : '';

    return (
        <>
            {!available && (
                <SettingsNotice tone={tones.warn} icon={<AlertCircle size={14} />}>
                    {t('Gmail is not available in this version of Natively yet.')}
                </SettingsNotice>
            )}

            <ActionArea
                note={note || undefined}
                secondary={waiting ? (
                    <button type="button" className={QUIET_BTN} onClick={() => void capi()?.cancelGmailConnect()}>{t('Cancel')}</button>
                ) : undefined}
                below={<FlashNotice flash={flash} />}
            >
                {status.connected ? (
                    <ConnectedPill confirmLabel={t('Disconnect Gmail?')} onDisconnect={() => void disconnect()} />
                ) : (
                    <ConnectPill label={t('Connect Gmail')} external waiting={waiting} disabled={!available} onClick={() => void connect()} />
                )}
            </ActionArea>

            <section className="mb-8">
                <GroupLabel>{t('Includes')}</GroupLabel>
                <div className="flex flex-col gap-3">
                    <FeatureCard
                        title="Follow-up emails"
                        description="Send a meeting's follow-up email from your own Gmail, once you have read it over."
                    />
                    <FeatureCard
                        title="Meeting briefs"
                        description="Before a meeting, its brief can mention your recent threads with the people you are meeting."
                        control={status.connected ? (
                            <SettingsSwitch
                                checked={status.briefsEnabled}
                                label={t('Use email in meeting briefs')}
                                onChange={() => void capi()?.setGmailBriefsEnabled(!status.briefsEnabled).then((s) => s && onStatus(s))}
                            />
                        ) : undefined}
                    />
                </div>
            </section>

            <UsageList title="How Gmail is used" rows={USAGE} />
        </>
    );
};
