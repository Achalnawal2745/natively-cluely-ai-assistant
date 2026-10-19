import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { SpellCheck, X } from 'lucide-react';
import { useT } from '../../i18n';
import {
    Collapse,
    EASE_SMOOTH_OUT,
    SETTINGS_BTN,
    SETTINGS_CARD,
    SETTINGS_INPUT,
    SettingsMotionReady,
    SettingsRow,
    useMotionReadyAfter,
} from './SettingsRow';

// Settings > Audio: the user's dictionary (electron/audio/userDictionary.ts).
// Names and words the transcript should spell right; the main process sends
// them to every speech provider that takes a word list. Built like the other
// Audio cards ("Follow the meeting app's mute", "Dictation"): one row with a
// tile, title and description, the count where a switch would sit, and under
// it a field with an Add button and the words as pills. Same platform-neutral
// list on macOS and Windows.

const MAX_TERMS = 100;

/** Providers that take a word list (electron/audio/sttContextTerms.ts). */
const USES_LIST = new Set(['natively', 'deepgram', 'soniox', 'google', 'groq', 'openai', 'local-whisper']);

/** One entry per line or comma, trimmed, case-insensitive duplicates dropped (the main process cleans again). */
function splitEntries(text: string): string[] {
    return text.split(/[\n,;]+/).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// A pill comes and goes with SettingsRow's "control" move: 250ms in from 0.96,
// 150ms out. No `layout`: layout projection broke scrolling in this scroller.
const PILL_IN = { opacity: 1, scale: 1, filter: 'blur(0px)', transition: { duration: 0.25, ease: EASE_SMOOTH_OUT } };
const PILL_OUT = (reduce: boolean) => ({ opacity: 0, scale: reduce ? 1 : 0.96, filter: 'blur(2px)', transition: { duration: 0.15, ease: EASE_SMOOTH_OUT } });

export const SpeechDictionarySettings: React.FC<{ sttProvider: string }> = ({ sttProvider }) => {
    const t = useT();
    const reduce = !!useReducedMotion();
    const [terms, setTerms] = useState<string[]>([]);
    const [draft, setDraft] = useState('');
    const [notSaved, setNotSaved] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const ready = useMotionReadyAfter(loaded);
    const saving = useRef(Promise.resolve());

    useEffect(() => {
        let alive = true;
        window.electronAPI?.getUserDictionary?.()
            .then((list) => { if (alive && Array.isArray(list)) setTerms(list); })
            .catch(() => { /* an empty list */ })
            .finally(() => { if (alive) setLoaded(true); });
        return () => { alive = false; };
    }, []);

    const save = (next: string[]) => {
        const previous = terms;
        setTerms(next);
        setNotSaved(false);
        // Saves in order, so a quick add then remove cannot land the other way round.
        saving.current = saving.current.then(async () => {
            try {
                const res = await window.electronAPI?.setUserDictionary?.(next);
                if (res?.success && Array.isArray(res.terms)) {
                    setTerms(res.terms);
                } else {
                    setTerms(previous);
                    setNotSaved(true);
                }
            } catch {
                setTerms(previous);
                setNotSaved(true);
            }
        });
    };

    const add = () => {
        const entries = splitEntries(draft);
        if (!entries.length) return;
        const seen = new Set(terms.map((x) => x.toLowerCase()));
        const next = [...terms];
        for (const e of entries) {
            if (next.length >= MAX_TERMS) break;
            if (seen.has(e.toLowerCase())) continue;
            seen.add(e.toLowerCase());
            next.push(e);
        }
        setDraft('');
        if (next.length !== terms.length) save(next);
    };

    const remove = (term: string) => save(terms.filter((x) => x !== term));
    const full = terms.length >= MAX_TERMS;
    const usesList = USES_LIST.has(sttProvider);

    return (
        <SettingsMotionReady.Provider value={ready}>
            <div className={SETTINGS_CARD}>
                <SettingsRow
                    icon={<SpellCheck size={20} />}
                    title={t('Dictionary')}
                    description={usesList
                        ? t('Names and words the transcript should spell right: people, companies, products.')
                        : t("Your current speech provider doesn't take a word list. Words you add are kept for one that does.")}
                    descriptionKey={usesList ? 'uses' : 'unused'}
                    control={(
                        <span className="text-xs text-text-secondary tabular-nums">
                            {terms.length} / {MAX_TERMS}
                        </span>
                    )}
                >
                    <div className="pb-4">
                        <div className="flex items-stretch gap-2">
                            <input
                                type="text"
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                                placeholder={full ? t('The list is full') : t('Add a name or word')}
                                aria-label={t('Add a name or word')}
                                disabled={!loaded || full}
                                className={`${SETTINGS_INPUT} flex-1 min-w-0`}
                            />
                            <button
                                type="button"
                                onClick={add}
                                disabled={!loaded || full || !draft.trim()}
                                className={SETTINGS_BTN}
                            >
                                {t('Add')}
                            </button>
                        </div>

                        {/* The list folds open and shut with the house Collapse, so the
                            last pill's exit still plays: a bare `terms.length > 0 &&` would
                            unmount its AnimatePresence along with it. Gap inside as padding. */}
                        <Collapse open={terms.length > 0}>
                            <ul className="pt-3 flex flex-wrap gap-1.5" aria-label={t('Dictionary')}>
                                <AnimatePresence initial={false}>
                                    {terms.map((term) => (
                                        <motion.li
                                            key={term}
                                            initial={ready ? { opacity: 0, scale: reduce ? 1 : 0.96, filter: 'blur(2px)' } : false}
                                            animate={PILL_IN}
                                            exit={PILL_OUT(reduce)}
                                            className="inline-flex items-center gap-0.5 max-w-full h-7 pl-2.5 pr-1 rounded-lg border border-border-subtle bg-bg-item-surface text-xs text-text-primary"
                                        >
                                            <span className="truncate">{term}</span>
                                            <button
                                                type="button"
                                                onClick={() => remove(term)}
                                                aria-label={`${t('Remove')} ${term}`}
                                                title={t('Remove')}
                                                className="shrink-0 w-5 h-5 grid place-items-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-150"
                                            >
                                                <X size={12} strokeWidth={2} />
                                            </button>
                                        </motion.li>
                                    ))}
                                </AnimatePresence>
                            </ul>
                        </Collapse>

                        <Collapse open={notSaved}>
                            <p className="pt-2 text-xs text-text-secondary">{t("That change wasn't saved. Try again.")}</p>
                        </Collapse>
                    </div>
                </SettingsRow>
            </div>
        </SettingsMotionReady.Provider>
    );
};
