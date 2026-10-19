// "Your style" in the follow-up tone picker (2026-10-17). The user's own voice
// (the writing samples of the mode the meeting ran under) is a tone of its own:
// the default when that mode has samples, and never mixed with a preset tone, so
// "Professional" over casual samples drafts professionally. Model calls are fakes.
//
// Run after `npm run build:electron`. No platform branch is involved.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dist = (p) => require(path.join(REPO, 'dist-electron/electron', p));
const style = dist('services/outputs/writingStyle.js');
const { FollowUpDraftGenerator, followUpRedraftPlan } = dist('services/meeting/FollowUpDraftGenerator.js');
const { followUpVoice } = dist('MeetingPersistence.js');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const summary = { title: 'Pricing call', overview: 'Held the list price.', tldr: ['List price held'], decisions: [{ text: 'Hold list price', confidence: 'high' }] };
const fakeLlm = (captured) => ({
    generateMeetingSummary: async (system) => { captured.push(system); return JSON.stringify({ subject: 'Holding the list price for now', body: 'Hi Sam,\n\nWe are holding the list price.\n\nThanks,' }); },
});
const GUIDE = style.renderStyleGuide({ sentenceLength: 'short', avgSentenceWords: 6, formality: 'casual', emoji: 'often', phrases: ['lmk'], description: 'Breezy, emoji-heavy.' });
const draft = async (params) => { const captured = []; const d = await new FollowUpDraftGenerator(fakeLlm(captured)).generate({ summary, mode: 'general', ...params }); return { d, prompt: captured[0] }; };

describe('the generator: one voice per draft', () => {
    test('a style and no tone asked: drafted in "Your style"', async () => {
        const { d, prompt } = await draft({ styleGuide: GUIDE });
        assert.equal(d.tone, 'your_style');
        assert.equal(d.styled, true);
        assert.ok(prompt.includes("WRITE IN THE SENDER'S OWN VOICE"));
        assert.ok(prompt.includes("Tone: the sender's own"));
    });
    test('a preset tone over a style: that tone alone, the style left out', async () => {
        const { d, prompt } = await draft({ tone: 'professional', styleGuide: GUIDE });
        assert.equal(d.tone, 'professional');
        assert.equal(d.styled, undefined);
        assert.ok(prompt.includes('Tone: professional and neutral.'));
        assert.ok(!prompt.includes('OWN VOICE'), 'no casual style pulling against Professional');
    });
    test('"Your style" with no samples left: the mode\'s default tone', async () => {
        const { d, prompt } = await draft({ tone: 'your_style' });
        assert.equal(d.tone, 'professional', "general mode's default");
        assert.ok(!prompt.includes("sender's own"));
    });
    test('no style, no tone: unchanged, the mode default', async () => {
        const { d } = await draft({});
        assert.equal(d.tone, 'professional');
        assert.equal(d.styled, undefined);
    });
    test('a notes Regenerate keeps a "Your style" draft in your style', () => {
        assert.deepEqual(followUpRedraftPlan({ body: 'Hi', tone: 'your_style' }), { redraft: true, tone: 'your_style' });
    });
});

describe('followUpVoice: which tone and style a draft gets', () => {
    const guideFor = (guides) => async (modeId) => guides[modeId];
    test('a preset tone: that tone, the samples never read', async () => {
        let read = 0;
        assert.deepEqual(await followUpVoice('mode-sales', 'concise', async () => { read += 1; return GUIDE; }), { tone: 'concise' });
        assert.equal(read, 0);
    });
    test('no tone asked and the mode has samples: "Your style" is the default', async () => {
        assert.deepEqual(await followUpVoice('mode-sales', undefined, guideFor({ 'mode-sales': GUIDE })), { tone: 'your_style', styleGuide: GUIDE });
        assert.deepEqual(await followUpVoice('mode-sales', 'your_style', guideFor({ 'mode-sales': GUIDE })), { tone: 'your_style', styleGuide: GUIDE });
    });
    test('no samples, no recorded mode, or a failed read: no tone (the mode default)', async () => {
        assert.deepEqual(await followUpVoice('mode-tech', undefined, guideFor({ 'mode-sales': GUIDE })), {});
        assert.deepEqual(await followUpVoice(undefined, 'your_style', guideFor({ 'mode-sales': GUIDE })), {});
        assert.deepEqual(await followUpVoice('mode-sales', undefined, async () => { throw new Error('disk'); }), {});
    });
});

describe('the wiring', () => {
    test('the draft path goes through followUpVoice', () => {
        const src = read('electron/MeetingPersistence.ts');
        assert.match(src, /const voice = await followUpVoice\(/);
        assert.match(src, /tone: voice\.tone,[\s\S]{0,80}styleGuide: voice\.styleGuide,/);
        assert.match(read('electron/services/meeting/MeetingContextAssembler.ts'), /styleGuide: params\.followUpStyleGuide,/);
    });
    test('every tone list knows "your_style"', () => {
        assert.match(read('electron/services/meeting/MeetingSummaryV3.ts'), /export type FollowUpTone = 'professional' \| 'warm' \| 'concise' \| 'friendly' \| 'your_style';/);
        for (const f of ['electron/preload.ts', 'src/types/electron.d.ts', 'electron/ipcHandlers.ts', 'electron/IntelligenceManager.ts']) {
            assert.doesNotMatch(read(f), /'friendly' \}/, `${f}: a tone union without 'your_style'`);
            assert.match(read(f), /'friendly' \| 'your_style'/, f);
        }
    });
    test('the picker: "Your style" first, only when the mode has samples; the first draft takes no tone; Reset keeps the picked tone', () => {
        const src = read('src/components/MeetingDetails.tsx');
        assert.match(src, /\.\.\.\(offerYourStyle \|\| followUpTone === 'your_style' \? \[\{ value: 'your_style' as const, label: t\('Your style'\) \}\] : \[\]\),\s*\{ value: 'professional'/);
        assert.match(src, /api\.getWritingStyle\(followUpStyleModeId\)/);
        assert.match(src, /offerYourStyle=\{modeHasStyle\}/);
        assert.match(src, /if \(!hasFollowUpDraft && !isRegeneratingFollowUp\) void handleRegenerateFollowUp\(\);/);
        assert.match(src, /const resetFollowUp = \(\) => \{[\s\S]{0,300}handleRegenerateFollowUp\(followUpTone\)/);
        assert.match(src, /onClick=\{resetFollowUp\}/);
    });
});
