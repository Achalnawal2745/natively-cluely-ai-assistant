// Shared pieces of the Connectors page: the list card (Granola's grouped card
// with dashed separators), and Granola's connector page: the header with its
// way back, the action row (glass Connect pill or Connected pill) and its rule,
// titled sections, "How it works", the folder picker and the line that says
// what was last sent.

import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Loader2, Unplug } from 'lucide-react';
import { useT } from '../../../i18n';
import { LiquidGlassButton } from '../../../ui-components/LiquidGlassButton';
import { SETTINGS_CARD, useSettingsTones } from '../SettingsRow';
import { AIP_CSS, AipSelect, type AipSelectOption } from '../AIProvidersSettings';
import { useResolvedTheme } from '../../../hooks/useResolvedTheme';
import type { DeliveryInfo, FolderOption } from '../../../types/connectors';

/** A small label over a group of rows, like Granola's "Integrations". */
export const GroupLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <h4 className="mb-2 px-1 text-sm font-medium text-text-secondary">{children}</h4>
);

/** Rows in one rounded card, split by dashed rules that stop short of the edges. */
export const ListCard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const rows = React.Children.toArray(children).filter(Boolean);
    return (
        <div className={`${SETTINGS_CARD} overflow-hidden`}>
            {rows.map((row, i) => (
                <React.Fragment key={i}>
                    {/* Granola's dashed rule: drawn in the tertiary ink at low opacity so it reads in both themes. */}
                    {i > 0 && <div aria-hidden className="mx-4 border-t border-dashed text-text-tertiary opacity-40" style={{ borderColor: 'currentColor' }} />}
                    {row}
                </React.Fragment>
            ))}
        </div>
    );
};

/** One row of a ListCard: logo, title, description, "Connected", chevron. The whole row opens the page. */
export const ListRow: React.FC<{
    icon: React.ReactNode;
    title: React.ReactNode;
    badge?: React.ReactNode;
    description?: React.ReactNode;
    status?: React.ReactNode;
    onOpen: () => void;
}> = ({ icon, title, badge, description, status, onOpen }) => (
    <button
        type="button"
        onClick={onOpen}
        className="group flex w-full items-center gap-4 px-4 py-3.5 text-left text-text-primary transition-colors hover:bg-bg-elevated/60"
    >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center">{icon}</span>
        <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-primary">{title}</span>
                {badge}
            </span>
            {description ? <span className="mt-0.5 block text-xs text-text-secondary">{description}</span> : null}
        </span>
        {status ? <span className="shrink-0 text-xs text-text-secondary">{status}</span> : null}
        <ChevronRight size={16} className="shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5" />
    </button>
);

/**
 * The top of a detail page, on Granola's: back to the list, then the logo in a
 * 56px tile beside the name in the display serif (24/28) and what it does.
 */
export const DetailHeader: React.FC<{ icon: React.ReactNode; title: string; description: string; onBack: () => void }> = ({ icon, title, description, onBack }) => {
    const t = useT();
    return (
        <div className="mb-6">
            <button
                type="button"
                onClick={onBack}
                className="-ml-1 mb-4 flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
                <ChevronLeft size={14} />
                {t('Connectors')}
            </button>
            <div className="flex items-start gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-border-muted bg-bg-item-surface text-text-primary">{icon}</div>
                <div className="flex min-w-0 flex-col gap-1.5 pt-1">
                    <h3 className="font-plex-serif text-2xl leading-7 text-text-primary">{t(title)}</h3>
                    <p className="text-sm text-text-secondary">{t(description)}</p>
                </div>
            </div>
        </div>
    );
};

/**
 * The page's one action as a dark grey Liquid Glass pill (the kit's neutral
 * material a step darker), the same as the MCP card's Turn on: 34px tall with
 * long caps, one width whatever the label.
 */
export const GLASS_PILL_CLASS = 'lg-sm lg-wide min-w-[124px] !px-7 ![background-color:#3a3a3c] hover:![background-color:#4a4a4d]';
export const GLASS_PILL_STYLE = { '--lg-pill-h': '34px', '--lg-label-size': '13px' } as React.CSSProperties;

/**
 * "Connected", Granola's way: a quiet pill that opens on hover (or focus) to
 * show a disconnect button beside it, its column easing from 0fr to 1fr. The
 * first press asks ("Disconnect Gmail?") and holds the pill open; a second
 * press within 4 seconds disconnects. Without onDisconnect it is just the pill
 * (Slack, where each channel is removed on its own).
 */
export const ConnectedPill: React.FC<{ label?: React.ReactNode; confirmLabel?: string; onDisconnect?: () => void }> = ({ label, confirmLabel, onDisconnect }) => {
    const t = useT();
    const tones = useSettingsTones();
    const [confirm, setConfirm] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);
    const press = () => {
        clearTimeout(timer.current);
        if (!confirm) {
            setConfirm(true);
            timer.current = setTimeout(() => setConfirm(false), 4000);
            return;
        }
        setConfirm(false);
        onDisconnect?.();
    };
    const ask = confirmLabel ?? t('Disconnect?');
    const open = confirm ? 'grid-cols-[max-content_1fr]' : 'grid-cols-[max-content_0fr] hover:grid-cols-[max-content_1fr] focus-within:grid-cols-[max-content_1fr]';
    return (
        <div className={`inline-grid h-[34px] max-w-full overflow-hidden rounded-full border border-border-muted bg-bg-item-surface text-[13px] transition-[grid-template-columns] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${onDisconnect ? open : 'grid-cols-[max-content]'}`}>
            <span className="flex min-w-0 items-center gap-1.5 pl-3.5 pr-3 text-text-secondary">
                <Check size={14} className="shrink-0" />
                <span className="max-w-[280px] truncate">{label ?? t('Connected')}</span>
            </span>
            {onDisconnect && (
                <span className="flex min-w-0 overflow-hidden">
                    <button
                        type="button"
                        onClick={press}
                        aria-label={confirm ? ask : t('Disconnect')}
                        title={confirm ? undefined : t('Disconnect')}
                        className={`flex h-full items-center gap-1.5 whitespace-nowrap border-l border-border-muted px-3 transition-colors duration-150 ${confirm ? tones.text.danger : 'text-text-tertiary hover:text-text-primary'}`}
                    >
                        <Unplug size={14} />
                        {confirm && <span>{ask}</span>}
                    </button>
                </span>
            )}
        </div>
    );
};

/**
 * The page's one action in the glass pill: "Connect Notion", with the arrow
 * Granola draws when the step happens in the browser, or "Connecting…" with a
 * spinner while it does.
 */
export const ConnectPill: React.FC<{
    label: string;
    external?: boolean;
    waiting?: boolean;
    disabled?: boolean;
    expanded?: boolean;
    onClick: () => void;
}> = ({ label, external, waiting, disabled, expanded, onClick }) => {
    const t = useT();
    return (
        <LiquidGlassButton
            variant="neutral"
            className={GLASS_PILL_CLASS}
            style={GLASS_PILL_STYLE}
            onClick={onClick}
            disabled={disabled || waiting}
            aria-expanded={expanded}
            icon={waiting ? <Loader2 size={14} className="animate-spin" /> : undefined}
        >
            {waiting ? t('Connecting…') : external ? (
                <span className="inline-flex items-center gap-1.5">{label}<ArrowUpRight size={14} /></span>
            ) : label}
        </LiquidGlassButton>
    );
};

/** A quiet text button beside the pill: Cancel, Test connection, Add channel. */
export const QUIET_BTN = 'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-text-tertiary transition-[color,transform] duration-150 hover:text-text-primary active:scale-[0.97] disabled:opacity-50';

/**
 * The top of every connector page under the header, as Granola's: the pill, a
 * short status beside it, quiet buttons at the end, whatever opens under them
 * (a result, a form), then a rule before the page's sections.
 */
export const ActionArea: React.FC<{ note?: React.ReactNode; secondary?: React.ReactNode; below?: React.ReactNode; children: React.ReactNode }> = ({ note, secondary, below, children }) => (
    <>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {children}
            {note ? <p className="min-w-0 flex-1 truncate text-xs text-text-tertiary">{note}</p> : <span className="flex-1" />}
            {secondary}
        </div>
        <div className="mt-3">{below}</div>
        <div aria-hidden className="mb-6 mt-3 h-px w-full bg-border-muted" />
    </>
);

/** One thing a connector adds, as Granola's "Includes" cards: a serif title, a line, and room for a switch. */
export const FeatureCard: React.FC<{ title: string; description: string; control?: React.ReactNode }> = ({ title, description, control }) => {
    const t = useT();
    return (
        <div className={`${SETTINGS_CARD} flex items-center gap-4 px-4 py-3.5`}>
            <div className="min-w-0 flex-1">
                <h5 className="font-plex-serif text-base leading-6 text-text-primary">{t(title)}</h5>
                <p className="mt-0.5 text-sm text-text-secondary">{t(description)}</p>
            </div>
            {control ? <div className="shrink-0">{control}</div> : null}
        </div>
    );
};

/** Granola's "How Gmail is used": plain promises, one per row, each with its icon in a small tile. */
export const UsageList: React.FC<{ title: string; rows: { icon: React.ReactNode; text: string }[] }> = ({ title, rows }) => {
    const t = useT();
    return (
        <section>
            <GroupLabel>{t(title)}</GroupLabel>
            <div className="overflow-hidden rounded-2xl border border-border-muted">
                {rows.map((row, i) => (
                    <React.Fragment key={i}>
                        {i > 0 && <div aria-hidden className="h-px bg-border-muted" />}
                        <div className="flex items-center gap-4 p-4">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-muted bg-bg-item-surface text-text-secondary">{row.icon}</span>
                            <p className="text-sm text-text-primary">{t(row.text)}</p>
                        </div>
                    </React.Fragment>
                ))}
            </div>
        </section>
    );
};

/** A titled block on a detail page, under the same quiet label as Granola's "Includes". */
export const DetailSection: React.FC<{ title: string; subtitle?: React.ReactNode; children: React.ReactNode }> = ({ title, subtitle, children }) => {
    const t = useT();
    return (
        <section className="mb-8">
            <h4 className="px-1 text-sm font-medium text-text-secondary">{t(title)}</h4>
            {subtitle ? <p className="mt-0.5 px-1 text-xs text-text-tertiary">{subtitle}</p> : null}
            <div className="mt-2">{children}</div>
        </section>
    );
};

/** Granola's "How it works": plain numbered steps, the numbers in the faint ink. */
export const HowItWorks: React.FC<{ lines: string[] }> = ({ lines }) => {
    const t = useT();
    return (
        <section className="mb-8">
            <h4 className="mb-2 px-1 text-sm font-medium text-text-secondary">{t('How it works')}</h4>
            <ol className="list-decimal space-y-1.5 pl-6 text-sm leading-relaxed text-text-primary marker:text-text-tertiary">
                {lines.map((line, i) => <li key={i} className="pl-1">{t(line)}</li>)}
            </ol>
        </section>
    );
};

/** The app's in-flow select. Never a native <select>: its popup leaks into
 *  screen shares (NoNativePopups2026_09_27). AipSelect reads its tokens from an
 *  .aip-root, so it brings one. */
export const ConnectorSelect: React.FC<{ label: string; value: string; options: AipSelectOption[]; onChange: (v: string) => void; disabled?: boolean }> = (props) => {
    const theme = useResolvedTheme();
    return (
        <div className="aip-root" data-theme={theme}>
            <AipSelect {...props} />
            <style>{AIP_CSS}</style>
        </div>
    );
};

/** "All meetings" or one folder. */
export const FolderSelect: React.FC<{ folders: FolderOption[]; value: string | null; onChange: (v: string | null) => void; disabled?: boolean; label?: string }> = ({ folders, value, onChange, disabled, label }) => {
    const t = useT();
    return (
        <ConnectorSelect
            label={label ?? t('Which meetings')}
            value={value ?? ''}
            disabled={disabled}
            onChange={(v) => onChange(v || null)}
            options={[{ id: '', name: t('All meetings') }, ...folders.map((f) => ({ id: f.id, name: f.name }))]}
        />
    );
};

export const folderName = (folders: FolderOption[], id: string | null, all: string): string => (id ? folders.find((f) => f.id === id)?.name ?? all : all);

/** "1 min ago", "3 h ago", "2 days ago", from a timestamp. */
export function ago(at: number, now: number = Date.now()): string {
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** What was last sent, and whether it got there. */
export const DeliveryLine: React.FC<{ delivery?: DeliveryInfo }> = ({ delivery }) => {
    const t = useT();
    const tones = useSettingsTones();
    if (!delivery) return <span className="text-xs text-text-tertiary">{t('Nothing sent yet.')}</span>;
    const what = delivery.meetingTitle ? `“${delivery.meetingTitle}”` : t('a meeting');
    if (delivery.status === 'success') return <span className="text-xs text-text-secondary">{t('Sent')} {what} {t(ago(delivery.at))}.</span>;
    if (delivery.status === 'pending') return <span className="text-xs text-text-secondary">{t('Sending')} {what}…</span>;
    return <span className={`text-xs ${tones.text.danger}`}>{delivery.message || `${t('Could not send')} ${what}.`}</span>;
};
