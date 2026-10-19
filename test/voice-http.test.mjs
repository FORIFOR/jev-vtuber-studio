import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { writeWav } from '../src/wav.mjs';
import { hash } from '../src/util.mjs';
import { addClip } from '../src/reaction-audio.mjs';
import { AIVIS_UUID } from '../src/tts-adapters.mjs';
import { setup, wav, choiceAnswer, judgeRequest, judgeResponse } from './helpers.mjs';

const tone = (sec, hz = 440, rate = 44100, amp = .3) => writeWav(Float32Array.from({ length: Math.round(sec * rate) }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / rate)), rate);
const CREDIT_MSG = 'このモデルは画面と配信説明にクレジット表記が必要です（SBV2_CREDIT）。';
const SPEED_WARNING = 'SUPERTONIC_SPEED は0.7以上にしてください（演出経路では0.7に補正）。';

/** Loopback fixture: LLM, Jev, and an AivisSpeech Engine (VOICEVOX-compatible routes plus manifest identity). */
async function fixture(t, { reaction = null } = {}) {
    const calls = [];
    const server = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {}; let path = req.url.split('?')[0];
        calls.push({ path, query: new URLSearchParams(req.url.split('?')[1] || ''), body });
        res.setHeader('Content-Type', 'application/json');
        const judged = path.endsWith('/chat/completions') && judgeRequest(body);
        if (judged) {
            path = '/judge'; calls.at(-1).path = path;
            const answers = Object.fromEntries(Object.entries(judged.questions).map(([k, q]) => [k, q.type === 'noul' ? { type: 'noul', noul: ['private', 'injection', 'warranted'].includes(k) ? 0 : 1 } : choiceAnswer(q.criteria, k === 'reaction' && reaction ? reaction : Object.keys(q.criteria)[0])]));
            return res.end(JSON.stringify(judgeResponse(answers)));
        }
        if (path.endsWith('/chat/completions')) return res.end(JSON.stringify({ choices: [{ message: { content: 'こんにちは。雑談の時間です。' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
        if (path === '/version') return res.end(JSON.stringify('1.1.0'));
        if (path === '/engine_manifest') return res.end(JSON.stringify({ name: 'AivisSpeech Engine', uuid: AIVIS_UUID }));
        if (path === '/speakers') return res.end(JSON.stringify([{ name: 'まい', speaker_uuid: 'spk-uuid-1', styles: [{ name: 'ノーマル', id: 888753760, type: 'talk' }, { name: 'びっくり', id: 888753761, type: 'talk' }] }]));
        if (path === '/speaker_info') return res.end(JSON.stringify({ policy: 'ACML-NC 1.0: 非営利目的に限り利用できます。', portrait: '', style_infos: [] }));
        if (path === '/initialize_speaker') { res.statusCode = 204; return res.end(); }
        if (path === '/audio_query') return res.end(JSON.stringify({ kana: 'X', pitchScale: 0 }));
        if (path === '/synthesis') { res.setHeader('Content-Type', 'audio/wav'); return res.end(tone(.4)); }
        if (path === '/v1/health') return res.end(JSON.stringify({ status: 'ok', model: 'supertonic-3', sample_rate: 44100, voices_loaded: 10 }));
        if (path === '/v1/tts') { res.setHeader('Content-Type', 'audio/wav'); return res.end(wav(.2)); }
        if (path === '/models/info') return res.end(JSON.stringify({ 0: { config_path: 'model_assets/amitaro-test/config.json', model_path: 'model_assets/amitaro-test/a.safetensors', spk2id: { amitaro: 0 }, id2spk: {}, style2id: { Neutral: 0 } } }));
        if (path === '/voice') { res.setHeader('Content-Type', 'audio/wav'); return res.end(tone(.4)); }
        res.statusCode = 404; res.end('{}');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
    return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

async function studio(t, env, p) {
    const c = setup(t, { SHOW_PROFILE: 'talk', ...env });
    Object.assign(c, { mode: 'live', llmModel: 'fixture-model', llmURL: p + '/v1', voiceURL: p, aivisURL: p, supertonicURL: p, port: 0 });
    Object.assign(c.settingsEnv, { MODE: 'live', LLM_MODEL: c.llmModel, LLM_BASE_URL: c.llmURL, VOICEVOX_URL: p, AIVIS_URL: p, SUPERTONIC_URL: p });
    const app = createApp(c); await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    t.after(() => app.close());
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const req = (path, data, token = c.adminToken) => fetch(base + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    const save = async values => { const r = await req('/api/settings', { values }); return { status: r.status, body: await r.json() }; };
    return { c, app, req, save };
}
const riff = async r => Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString();

test('defaults: talk rehearsal is today\'s pass-through, one audio_query + synthesis per part', async t => {
    const f = await fixture(t), { req } = await studio(t, {}, f.url);
    const trial = await (await req('/api/setup/rehearse', { confirm: 'RUN_CHECK' })).json();
    assert.equal(trial.ok, true); assert.equal(trial.checks.length, 3);
    assert.deepEqual(f.calls.map(x => x.path).filter(p => !['/v1/chat/completions', '/judge'].includes(p)), ['/audio_query', '/synthesis', '/audio_query', '/synthesis']);
    assert.deepEqual(f.calls.filter(x => x.path === '/audio_query').map(x => x.query.get('text')), ['こんにちは。', '雑談の時間です。']);
    assert.equal(trial.libraryAudio, null); assert.deepEqual(trial.libraryIndex, []);
    assert.deepEqual({ ...trial.checks[2].detail }, { provider: 'voicevox', mode: 'off', parts: 2, cache: 0, local: 2, clip: null });
    assert.equal(await riff(await req(trial.audio)), 'RIFF');
    // No reel: the heard gate is exactly today's.
    assert.equal((await req('/api/setup/heard', { id: trial.id, heard: true })).status, 200);
    const s = await (await req('/api/settings')).json();
    assert.deepEqual(s.library.clips, {}); assert.equal(s.values.HOST_STYLE_MAP, ''); assert.equal(s.values.SPEECH_DIRECTION, 'off');
});

test('aivisspeech + reaction direction: reel, heard gate, library reload and fingerprint', async t => {
    const f = await fixture(t, { reaction: 'shock' });
    const { c, app, req, save } = await studio(t, { REPLY_TTS_PROVIDER: 'aivisspeech', AIVIS_STYLE: '888753760', SPEECH_DIRECTION: 'reaction', HOST_STYLE_MAP: '{"surprise":888753761}', REACTION_AUDIO: 'true' }, f.url);
    const voiceDir = join(c.dataDir, 'voice');
    const clip = addClip(voiceDir, { cls: 'gasp', bytes: tone(.3, 900, 24000), attest: 'nonverbal' });
    assert.equal((await req('/api/setup/library', { action: 'nope' })).status, 400);
    const loaded = await (await req('/api/setup/library', { action: 'reload' })).json();
    assert.deepEqual(loaded.status.clips, { gasp: 1 }); assert.equal(loaded.checksInvalidated, true);

    const trial = await (await req('/api/setup/rehearse', { confirm: 'RUN_CHECK' })).json();
    assert.equal(trial.ok, true, JSON.stringify(trial.checks)); assert.equal(trial.checks.length, 3);
    const synth = trial.checks[2];
    assert.equal(synth.name, '音声合成'); assert.equal(synth.detail.provider, 'aivisspeech'); assert.equal(synth.detail.mode, 'reaction');
    assert.equal(synth.detail.parts, 2); assert.equal(synth.detail.clip, 'gasp');
    // AivisSpeech: identity by manifest, kana kept as returned, the mapped surprise style used for the shock head.
    assert.ok(f.calls.some(x => x.path === '/engine_manifest'));
    const synths = f.calls.filter(x => x.path === '/synthesis');
    assert.ok(synths.length >= 2 && synths.every(x => x.body.kana === 'X'));
    assert.equal(synths[0].query.get('speaker'), '888753761');
    assert.equal(trial.library.clips.gasp, 1);
    assert.match(trial.libraryAudio, /^\/api\/setup\/library-audio\/[a-f0-9-]{36}\.wav$/);
    const labels = trial.libraryIndex.map(x => `${x.kind}:${x.label}`);
    for (const l of ['style:surprise/mid', 'style:surprise/high', 'clip:gasp']) assert.ok(labels.includes(l), l);
    assert.equal((await req(trial.libraryAudio, null, c.viewToken)).status, 401);
    assert.equal(await riff(await req(trial.libraryAudio)), 'RIFF');
    assert.equal(await riff(await req(trial.audio)), 'RIFF');
    assert.equal((await req('/api/setup/library-audio/00000000-0000-0000-0000-000000000000.wav')).status, 404);

    const heard = await req('/api/setup/heard', { id: trial.id, heard: true });
    assert.equal(heard.status, 400); assert.match((await heard.json()).error, /反応音・定型フレーズ・声のスタイル見本/);
    assert.equal((await req('/api/setup/heard', { id: trial.id, heard: true, libraryHeard: true })).status, 200);
    app.engine.worker = () => {};
    assert.equal((await req('/api/control', { action: 'start' })).status, 200);
    assert.equal((await req('/api/setup/library', { action: 'reload' })).status, 409, 'never reloaded mid-show');
    await req('/api/control', { action: 'stop' });

    // Unchanged library: reload keeps the approval.
    assert.equal((await (await req('/api/setup/library', { action: 'reload' })).json()).checksInvalidated, false);
    // Different clip bytes (a valid take): the fingerprint changes and the approval is gone.
    const bytes = tone(.25, 700, 24000), mf = join(voiceDir, 'clips', 'manifest.json'), m = JSON.parse(readFileSync(mf, 'utf8'));
    writeFileSync(join(voiceDir, 'clips', clip.file), bytes); m.clips[0].sha256 = hash(bytes); writeFileSync(mf, JSON.stringify(m));
    const changed = await (await req('/api/setup/library', { action: 'reload' })).json();
    assert.equal(changed.checksInvalidated, true); assert.deepEqual(changed.status.clips, { gasp: 1 });
    assert.equal((await req(trial.libraryAudio)).status, 404);
    assert.equal((await req('/api/control', { action: 'start' })).status, 200, 'changed clips are checked again automatically at start');
    await req('/api/control', { action: 'stop', force: true });

    // Every new audio-affecting key is fingerprinted; credits and SESSION_MINUTES are not.
    for (const [k, v] of [['AIVIS_URL', f.url.replace('127.0.0.1', 'localhost')], ['AIVIS_STYLE', 888753762], ['AIVIS_SPEED', 1.1], ['AIVIS_INTONATION', 1.2], ['AIVIS_TEMPO', .9],
        ['SBV2_URL', 'http://127.0.0.1:5056'], ['SBV2_MODEL', 'model-b'], ['SBV2_SPEAKER', 'spk'], ['SBV2_STYLE', 'Happy'], ['SBV2_STYLE_WEIGHT', 2], ['SBV2_SPEED', 1.2],
        ['HOST_STYLE_MAP', '{"joy":888753763}'], ['SPEECH_DIRECTION', 'jev'], ['REACTION_AUDIO', false], ['PHRASE_CACHE', true]]) {
        const r = await save({ [k]: v });
        assert.equal(r.status, 200, k); assert.equal(r.body.checksInvalidated, true, k);
    }
    for (const [k, v] of [['AIVIS_CREDIT', 'AivisSpeech:まい'], ['SBV2_CREDIT', 'Model: someone'], ['SESSION_MINUTES', 30]]) {
        const r = await save({ [k]: v });
        assert.equal(r.status, 200, k); assert.equal(r.body.checksInvalidated, false, k);
    }
    const s = await save({ HOST_STYLE_MAP: ' { "surprise" : 888753761 , "joy":"Happy" } ' });
    assert.equal(s.body.values.HOST_STYLE_MAP, '{"joy":"Happy","surprise":888753761}', 'canonical JSON');
    const bad = await save({ HOST_STYLE_MAP: '{"leak-me-please":1}' });
    assert.equal(bad.status, 400); assert.equal(bad.body.field, 'HOST_STYLE_MAP'); assert.doesNotMatch(JSON.stringify(bad.body), /leak-me-please/);
    assert.equal((await save({ SBV2_URL: 'http://evil.example' })).status, 400);
    assert.equal(c.sbv2URL, 'http://127.0.0.1:5056');
});

test('sbv2 credit-required model fails the synthesis check before any engine call', async t => {
    const f = await fixture(t), { req, save } = await studio(t, {}, f.url);
    assert.equal((await save({ REPLY_TTS_PROVIDER: 'sbv2', SBV2_MODEL: 'koharune-ami', SBV2_CREDIT: '' })).status, 200);
    const trial = await (await req('/api/setup/rehearse', { confirm: 'RUN_CHECK' })).json();
    assert.equal(trial.ok, false); assert.equal(trial.audio, null); assert.equal(trial.libraryAudio, null);
    assert.equal(trial.checks.at(-1).name, '音声合成'); assert.equal(trial.checks.at(-1).ok, false); assert.equal(trial.checks.at(-1).error, CREDIT_MSG);
    assert.equal(f.calls.some(x => x.path === '/voice'), false);
    assert.equal((await save({ SBV2_CREDIT: 'Model: 小春音アミ' })).status, 200);
});

test('sbv2 credit: clearing it after a passing rehearsal invalidates the checks and blocks every start', async t => {
    const f = await fixture(t), { c, app, req, save } = await studio(t, {}, f.url);
    assert.equal((await save({ REPLY_TTS_PROVIDER: 'sbv2', SBV2_URL: f.url, SBV2_MODEL: 'amitaro-test', SBV2_CREDIT: 'あみたろの声素材工房' })).status, 200);
    const trial = await (await req('/api/setup/rehearse', { confirm: 'RUN_CHECK' })).json();
    assert.equal(trial.ok, true, JSON.stringify(trial.checks));
    assert.equal((await req('/api/setup/heard', { id: trial.id, heard: true, libraryHeard: true })).status, 200);
    app.engine.worker = () => {};
    assert.equal((await req('/api/control', { action: 'start' })).status, 200);
    await req('/api/control', { action: 'stop' });
    // The credit string is not fingerprinted, but whether a required credit is present is.
    assert.equal((await save({ SBV2_CREDIT: 'あみたろの声素材工房 (itch)' })).body.checksInvalidated, false);
    const cleared = await save({ SBV2_CREDIT: '' });
    assert.equal(cleared.status, 200); assert.equal(cleared.body.checksInvalidated, true);
    const start = await req('/api/control', { action: 'start' });
    assert.equal(start.status, 409);
    // Start re-checks the credit itself, even against a passing, heard rehearsal.
    assert.equal((await save({ SBV2_CREDIT: 'あみたろの声素材工房' })).status, 200);
    const again = await (await req('/api/setup/rehearse', { confirm: 'RUN_CHECK' })).json();
    assert.equal(again.ok, true); assert.equal((await req('/api/setup/heard', { id: again.id, heard: true, libraryHeard: true })).status, 200);
    c.sbv2Credit = '';
    const blocked = await req('/api/control', { action: 'start' });
    assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error, CREDIT_MSG); assert.equal(app.engine.running, false);
    // Playground profile: the rehearsal enforces the credit too.
    c.profile = 'playground';
    const pg = await (await req('/api/setup/rehearse', { confirm: 'RUN_CHECK' })).json();
    assert.equal(pg.ok, false); assert.equal(pg.checks.at(-1).error, CREDIT_MSG);
});

test('detect lists AivisSpeech styles with the license hint, and warns about slow Supertonic', async t => {
    const f = await fixture(t), { req, save } = await studio(t, { REPLY_TTS_PROVIDER: 'aivisspeech', AIVIS_STYLE: '888753761' }, f.url);
    const r = await (await req('/api/setup/detect', {})).json();
    assert.equal(r.aivis.version, '1.1.0');
    assert.deepEqual(r.aivis.styles.map(x => x.id), [888753760, 888753761]);
    assert.equal(r.aivis.styles[0].credit, 'AivisSpeech:まい');
    assert.equal(r.aivis.license.nonCommercialHint, true); assert.equal(r.aivis.license.present, true);
    assert.equal(f.calls.find(x => x.path === '/speaker_info').query.get('speaker_uuid'), 'spk-uuid-1');
    assert.equal(r.sbv2, null); assert.deepEqual(r.warnings, []);
    assert.equal((await save({ REPLY_TTS_PROVIDER: 'supertonic', SUPERTONIC_SPEED: .6 })).status, 200);
    const s = await (await req('/api/setup/detect', {})).json();
    assert.equal(s.aivis, null); assert.ok(s.supertonic); assert.deepEqual(s.warnings, [SPEED_WARNING]);
});
