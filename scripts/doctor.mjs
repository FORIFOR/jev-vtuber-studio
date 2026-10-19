import { config, loadEnv } from '../src/config.mjs';
import { Ledger, Audit } from '../src/store.mjs';
import { Jev, noul } from '../src/jev.mjs';
import { SupertonicVoice } from '../src/voice-routing.mjs';
import { request } from '../src/util.mjs';
import { join } from 'node:path';
import { createAdapter } from '../src/tts-adapters.mjs';
import { ReactionAudioCache } from '../src/reaction-audio.mjs';
import { effectiveMode } from '../src/speech-director.mjs';
loadEnv();
try {
    const c = config(), result = { node: process.version, mode: c.mode, bindings: '127.0.0.1 only', scope: 'metadata only; not a live rehearsal or hearing check', output: c.allowStream ? 'explicit OBS start allowed' : 'OBS start disabled', checks: [] };
    const check = async (name, fn) => { try {
        const detail = await fn();
        result.checks.push({ name, ok: true, detail });
    }
    catch (e) {
        result.checks.push({ name, ok: false, error: e.code || e.name });
    } };
    const ledger = new Ledger(c.dataDir, c.limits);
    result.usage = ledger.snapshot();
    // Metadata only: file checks and engine probes, never a synthesis.
    await check('Voice library', async () => {
        const s = new ReactionAudioCache(join(c.dataDir, 'voice')).reload();
        if (s.errors.length) throw Object.assign(new Error(), { name: `${s.errors.length} library entries rejected (npm run voice:library -- verify)` });
        return { clips: s.clips, phrases: s.phrases, errors: 0, hash8: s.hash8 || null };
    });
    result.checks.push({ name: 'Speech direction', ok: true, detail: { configured: c.speechDirection, effective: effectiveMode(c), reactionAudio: c.reactionAudio, phraseCache: c.phraseCache } });
    if (c.mode === 'demo')
        result.checks.push({ name: 'offline demo', ok: true, detail: 'No Jev, LLM, TTS or search requests made. Japanese browser voice availability must be checked in the UI.' });
    else {
        if (c.replyTtsProvider === 'voicevox' || c.readComments) {
            await check('VOICEVOX', async () => ({ version: await request(`${c.voiceURL}/version`, { timeout: 3000 }) }));
            const ids = [...new Set([...(c.replyTtsProvider === 'voicevox' ? [c.speaker] : []), ...(c.readComments ? [c.commentSpeaker] : [])])];
            for (const id of ids) await check(`VOICEVOX style ${id}`, async () => {
                const speakers = await request(`${c.voiceURL}/speakers`, { timeout: 3000 });
                const speaker = speakers.find(x => x.styles?.some(s => s.id === id));
                if (!speaker) throw new Error('Speaker id not installed');
                return { speaker: speaker.name, credit: `VOICEVOX:${speaker.name}` };
            });
        }
        if (c.replyTtsProvider === 'supertonic') await check('Supertonic 3 metadata', async () => new SupertonicVoice(c, ledger).health());
        if (c.replyTtsProvider === 'aivisspeech') await check('AivisSpeech Engine', async () => {
            const a = createAdapter('aivisspeech', c), r = await a.probe();
            if (!(await a.voices()).some(v => v.id === c.aivisStyle)) throw Object.assign(new Error(), { name: 'AIVIS_STYLE not installed' });
            return { version: r.version, style: c.aivisStyle };
        });
        if (c.replyTtsProvider === 'sbv2') {
            const airplay = new URL(c.sbv2URL).port === '5000' ? 'macOS AirPlay may occupy :5000; the default SBV2_URL port is 5055' : null;
            try { const r = await createAdapter('sbv2', c).probe(); result.checks.push({ name: 'Style-Bert-VITS2', ok: true, detail: { model: r.detail.model, styles: r.detail.styles, ...(airplay ? { note: airplay } : {}) } }); }
            catch (e) { result.checks.push({ name: 'Style-Bert-VITS2', ok: false, error: e.code || e.name, ...(airplay ? { detail: airplay } : {}) }); }
        }
        if (c.llmProvider === 'compatible')
            await check('conversation model', async () => { const r = await request(`${c.llmURL}/models`, { headers: c.llmKey ? { Authorization: `Bearer ${c.llmKey}` } : {}, timeout: 5000 }); if (!r.data?.some(x => x.id === c.llmModel))
                throw new Error('Model id not in /models'); return 'Configured model appears in provider model list.'; });
        else if (c.llmProvider === 'ollama')
            await check('Ollama model', async () => { const r = await request(`${c.llmURL.replace(/\/v1$/, '')}/api/tags`, { timeout: 5000 }); if (!r.models?.some(x => (x.name || x.model) === c.llmModel)) throw new Error('Model not installed'); return 'Model is listed; inference is not tested by doctor.'; });
        else
            result.checks.push({ name: 'Gemini', ok: null, detail: 'Configured, not called. Validate model access using a local rehearsal.' });
        if (process.argv.includes('--probe-jev'))
            await check('Jev paid probe', async () => { const a = await new Jev(c, ledger, new Audit(c.dataDir)).ask({ message: 'こんにちは' }, { greeting: noul('Is state.message a greeting?') }); return { noul: a.greeting.noul }; });
        else
            result.checks.push({ name: 'Jev', ok: null, detail: 'Configured, not called. Add --probe-jev to make one metered request.' });
        result.checks.push({ name: 'YouTube / OBS / VTube Studio / jev-search', ok: null, detail: 'Not connected by doctor. Rehearse each explicitly before publishing.' });
    }
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.checks.some(x => x.ok === false) ? 1 : 0;
}
catch (e) {
    console.error(`Doctor: ${e.message}`);
    process.exitCode = 1;
}
