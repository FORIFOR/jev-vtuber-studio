import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REACTIONS, JEV_REACTIONS, demoReaction } from '../public/avatar-rig.mjs';
import { VOICE_ACTING, VOICE_FAMILIES, INTENSITIES, PACES, ENDINGS, INTENSITY_GAIN, NONVERBAL, NONVERBAL_TEXT, CLIP_COOLDOWN_MS, CLIP_MIN_SPACING_MS,
    voiceActing, calmReaction, clipCompatible, clipAllowedForText, voiceLead, ClipGovernor } from '../public/voice-acting.mjs';
import { DIRECTION_LIMITS, INTERJECTION, chunkPart, chunkText, isInterjection, effectiveMode, punctuationEnding, chunkDeliveryFor,
    deliveryQuestions, readDelivery, demoDelivery, assertCovers, SpeechDirector } from '../src/speech-director.mjs';
import { sentences } from '../src/director.mjs';
import { validateAnswers } from '../src/jev.mjs';

const ROOT = new URL('../', import.meta.url);
const ACTABLE = Object.keys(REACTIONS).filter(k => !REACTIONS[k].local);
const answer = (criteria, pick, confidence = .9) => ({ type: 'choice', choice: pick, confidence, probabilities: Object.fromEntries(Object.keys(criteria).map(k => [k, k === pick ? 1 : 0])) });
/** Mirrors Jev.ask(): each extra key is validated on its own; invalid ones are omitted and mark the delivery defaulted. */
function extras(questions, picks) {
    const answers = {}; let defaulted = false;
    for (const [k, q] of Object.entries(questions)) {
        if (!picks[k]) continue;
        try { answers[k] = validateAnswers({ answers: { [k]: answer(q.criteria, ...picks[k]) } }, { [k]: q })[k]; } catch { defaulted = true; }
    }
    return { answers, defaulted };
}
const mulberry = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
function demoTexts() {
    const out = [], walk = (x, key) => {
        if (typeof x === 'string') { if (key === 'demo') out.push(x); }
        else if (Array.isArray(x)) for (const y of x) walk(y, key);
        else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) walk(v, k);
    };
    walk(JSON.parse(readFileSync(new URL('config/programmes.json', ROOT), 'utf8')));
    return out;
}
const TOKENS = [...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんっゃゅょアイウエオカキクケコサシスセソタチツテトナニヌネノ', ...'星部屋家具収納服椅子机寝台考案今日夜話', ...'、、、。。！？〜…ー', 'えっ', 'あれ', 'なるほど', 'うわー', 'やった', 'うーん', 'はっ', 'あはは', 'ふう'];
function randomTexts(n, seed = 7) {
    const rnd = mulberry(seed), out = [];
    const lead = ['えっ、', 'あれ？', 'なるほど、', 'うわー！', 'ねえ、', 'やったぁ！', 'ふふっ、', 'あっ…'];
    for (let i = 0; i < n; i++) {
        let s = rnd() < .35 ? lead[Math.floor(rnd() * lead.length)] : ''; const len = s.length + 1 + Math.floor(rnd() * 90);
        while (s.length < len) s += TOKENS[Math.floor(rnd() * TOKENS.length)];
        out.push(s);
    }
    return out;
}
const tamper = plan => structuredClone(plan);
const code = e => e?.code === 'PLAN_INVARIANT' && e.message === 'Direction altered text';

test('VOICE_ACTING covers every preset; listen has no voice; values stay inside the shared vocab', () => {
    assert.deepEqual(Object.keys(VOICE_ACTING).sort(), Object.keys(REACTIONS).sort());
    assert.equal(VOICE_ACTING.listen.voice, null); assert.equal(VOICE_ACTING.listen.clip, null);
    for (const [name, a] of Object.entries(VOICE_ACTING)) {
        if (name === 'listen') continue;
        assert.ok(VOICE_FAMILIES.includes(a.voice.family), name);
        assert.ok(INTENSITIES.includes(a.voice.intensity), name); assert.ok(PACES.includes(a.voice.pace), name);
    }
    assert.deepEqual(INTENSITY_GAIN, { low: .7, mid: 1, high: 1.25 });
    assert.deepEqual(ENDINGS, ['continue', 'beat', 'hold']);
    assert.deepEqual(VOICE_FAMILIES, ['neutral', 'calm', 'joy', 'surprise', 'shy', 'think', 'worry']);
});

test('every big preset speaks exactly like its fallback, so a publication downgrade never contradicts rendered audio', () => {
    const big = Object.keys(REACTIONS).filter(k => REACTIONS[k].big);
    assert.deepEqual(big.sort(), ['excited', 'laugh', 'shock']);
    for (const p of big) {
        assert.deepEqual(VOICE_ACTING[p].voice, VOICE_ACTING[REACTIONS[p].fallback].voice, p);
        assert.equal(VOICE_ACTING[p].voice, VOICE_ACTING[REACTIONS[p].fallback].voice, `${p} shares the voice object`);
    }
});

test('fallback presets carry no clip; clips and NONVERBAL reactions use the closed vocabularies', () => {
    for (const r of Object.values(REACTIONS)) if (r.fallback) assert.equal(VOICE_ACTING[r.fallback].clip, null, r.fallback);
    for (const [name, a] of Object.entries(VOICE_ACTING)) if (a.clip) assert.ok(Object.hasOwn(NONVERBAL, a.clip.cls), name);
    assert.deepEqual(Object.keys(NONVERBAL), ['gasp', 'laugh_small', 'laugh_big', 'breath_in', 'breath_out', 'sigh', 'hmm']);
    for (const [cls, n] of Object.entries(NONVERBAL)) {
        assert.ok(['pre', 'post'].includes(n.position), cls);
        for (const name of n.reactions) assert.ok(Object.hasOwn(REACTIONS, name) && !REACTIONS[name].local, `${cls}: ${name}`);
        assert.equal(typeof NONVERBAL_TEXT[cls], 'string'); assert.ok(CLIP_COOLDOWN_MS[cls] > 0, cls);
    }
    assert.equal(NONVERBAL.hmm.mouth, .2);
    assert.deepEqual(Object.keys(NONVERBAL_TEXT).sort(), Object.keys(NONVERBAL).sort());
    assert.throws(() => NONVERBAL.gasp.reactions.push('happy'), TypeError);
});

test('voiceActing and calmReaction resolve unknown and local names to neutral', () => {
    assert.equal(voiceActing('listen'), VOICE_ACTING.neutral);
    assert.equal(voiceActing('<x>'), VOICE_ACTING.neutral);
    assert.equal(voiceActing(undefined), VOICE_ACTING.neutral);
    assert.equal(voiceActing('constructor'), VOICE_ACTING.neutral);
    assert.equal(voiceActing('shock'), VOICE_ACTING.shock);
    assert.equal(calmReaction('shock'), 'surprised');
    assert.equal(calmReaction('laugh'), 'happy'); assert.equal(calmReaction('excited'), 'happy');
    assert.equal(calmReaction('thinking'), 'thinking'); assert.equal(calmReaction('listen'), 'neutral'); assert.equal(calmReaction('<x>'), 'neutral');
});

test('clipCompatible follows VOICE_ACTING in reaction mode and NONVERBAL lists in jev mode', () => {
    assert.equal(clipCompatible('gasp', 'shock', 'reaction'), true);
    assert.equal(clipCompatible('gasp', 'surprised', 'reaction'), false, 'downgraded shock drops its gasp');
    assert.equal(clipCompatible('laugh_big', 'laugh', 'reaction'), true);
    assert.equal(clipCompatible('laugh_big', 'happy', 'reaction'), false);
    assert.equal(clipCompatible('breath_in', 'excited', 'reaction'), true);
    assert.equal(clipCompatible('laugh_small', 'embarrassed', 'reaction'), true);
    assert.equal(clipCompatible('gasp', 'listen', 'reaction'), false);
    assert.equal(clipCompatible(undefined, 'neutral', 'reaction'), false);
    assert.equal(clipCompatible('gasp', 'surprised', 'jev'), true);
    assert.equal(clipCompatible('laugh_big', 'happy', 'jev'), false);
    assert.equal(clipCompatible('breath_out', 'neutral', 'jev'), true);
    assert.equal(clipCompatible('constructor', 'neutral', 'jev'), false);
    assert.equal(clipCompatible('gasp', 'shock', 'off'), false);
});

test('clipAllowedForText refuses a clip whose sound the words already carry', () => {
    for (const [cls, text] of [['laugh_big', 'あはは、それは面白い！'], ['laugh_small', 'それは面白いね笑'], ['laugh_small', 'それは面白いねあはは！'], ['laugh_small', 'ふふっ。'], ['laugh_big', 'えへへ、照れるな。'],
        ['hmm', 'うーん、どうだろう。'], ['hmm', 'えーと、次はね。'], ['hmm', 'んー、迷うね。'], ['breath_out', 'やっと終わった、はぁ…'], ['sigh', 'ふう。'], ['sigh', 'まあいいか、はあ！'],
        ['gasp', 'はっ、そうか！'], ['gasp', 'ひっ！']])
        assert.equal(clipAllowedForText(cls, text), false, `${cls}: ${text}`);
    for (const [cls, text] of [['laugh_big', 'それは面白いね。'], ['hmm', 'それは難しいね。'], ['breath_out', 'よかった。'], ['gasp', 'えっ、ちょっと待って！'], ['bogus', 'あはは']])
        assert.equal(clipAllowedForText(cls, text), true, `${cls}: ${text}`);
});

test('ClipGovernor enforces per-class cooldowns and 8 s spacing; allow() never mutates', () => {
    let t = 100000; const g = new ClipGovernor(() => t);
    assert.equal(CLIP_MIN_SPACING_MS, 8000);
    assert.equal(g.allow('gasp'), true); assert.equal(g.allow('gasp'), true);
    assert.deepEqual({ ...g.last }, {}); assert.equal(g.lastAny, -Infinity);
    assert.equal(g.allow('bogus'), false); assert.equal(g.allow('constructor'), false);
    g.commit('gasp');
    t += 7999;
    assert.equal(g.allow('gasp'), false); assert.equal(g.allow('hmm'), false, 'spacing applies across classes');
    const snap = { last: { ...g.last }, lastAny: g.lastAny };
    t += 1;
    assert.equal(g.allow('gasp'), true); assert.equal(g.allow('hmm'), true);
    assert.deepEqual({ last: { ...g.last }, lastAny: g.lastAny }, snap, 'allow() does not mutate');
    g.commit('hmm');
    t += 8000;
    assert.equal(g.allow('hmm'), false, 'hmm cooldown is 30 s'); assert.equal(g.allow('gasp'), true);
    t = 108000 + 30000;
    assert.equal(g.allow('hmm'), true);
    assert.equal(g.allow('sigh', 0), false, 'explicit time is honoured');
});

test('voiceLead bounds the reflex lead and defers to a server lead', () => {
    assert.equal(voiceLead(280, 0), 0);
    assert.equal(voiceLead(280, undefined), 280);
    assert.equal(voiceLead(500, NaN), 400);
    assert.equal(voiceLead(200, 50), 50); assert.equal(voiceLead(200, 900), 200);
    assert.equal(voiceLead(-5, 100), 0); assert.equal(voiceLead('x', null), 0); assert.equal(voiceLead(120, -3), 0);
});

test('public/voice-acting.mjs is browser-servable and imports only avatar-rig; the director never imports jev', () => {
    const acting = readFileSync(new URL('public/voice-acting.mjs', ROOT), 'utf8');
    assert.deepEqual([...acting.matchAll(/\bfrom\s+'([^']+)'/g)].map(m => m[1]), ['./avatar-rig.mjs']);
    assert.ok(/^\/[a-z0-9_-]+\.(html|css|mjs|png)$/i.test('/voice-acting.mjs'));
    const director = readFileSync(new URL('src/speech-director.mjs', ROOT), 'utf8');
    const imports = [...director.matchAll(/\bfrom\s+'([^']+)'/g)].map(m => m[1]);
    assert.ok(imports.every(x => ['./director.mjs', '../public/voice-acting.mjs', '../public/avatar-rig.mjs'].includes(x)), imports.join());
    assert.doesNotMatch(director, /jev\.mjs|node:|fetch\(/);
});

test('chunkPart: leading interjection and one 、 split, never altering text', () => {
    assert.deepEqual(chunkPart('えっ、ちょっと待って！'), ['えっ、', 'ちょっと待って！']);
    assert.deepEqual(chunkPart('お茶が好き。'), ['お茶が好き。']);
    assert.deepEqual(chunkPart('ええと、それでね。'), ['ええと、それでね。']);
    assert.deepEqual(chunkPart('あれ？'), ['あれ？']);
    const long = 'なるほど、洗った服を床に置く案だと、歩くたびに小さな障害物が増えそう、きれいにしたはずの服を。';
    assert.deepEqual(chunkPart(long), ['なるほど、', '洗った服を床に置く案だと、', '歩くたびに小さな障害物が増えそう、きれいにしたはずの服を。']);
    const short = '今日は、少しだけ寄り道しよう。'; assert.deepEqual(chunkPart(short), [short], 'no split at or under 28 characters');
    const lopsided = 'ねえ君、' + 'あ'.repeat(40) + '。'; assert.equal(chunkPart(lopsided).length, 1, 'no split when a side is under 8 characters');
    assert.equal(isInterjection('えっ、'), true); assert.equal(isInterjection('あれ？'), true); assert.equal(isInterjection('えっ、ちょっと'), false);
    assert.ok(INTERJECTION.test('うわっ、すごい'));
});

test('fuzz: every demo text and 300 random strings chunk into ≤3 exact substrings', () => {
    const texts = [...demoTexts(), ...randomTexts(300)];
    assert.ok(texts.length > 300);
    let splits = 0, interjections = 0;
    for (const text of texts) {
        const { parts, chunks, flat } = chunkText(text);
        assert.deepEqual(parts, sentences(text));
        assert.deepEqual(flat, chunks.flat());
        parts.forEach((part, i) => {
            const cs = chunkPart(part);
            assert.deepEqual(chunks[i], cs);
            assert.equal(cs.join(''), part, part); assert.ok(cs.length >= 1 && cs.length <= DIRECTION_LIMITS.maxChunksPerPart, part);
            assert.ok(cs.every(c => c.length > 0), part);
            if (cs.length > 1 && !isInterjection(cs[0])) splits++;
            if (isInterjection(cs[0]) && cs.length > 1) interjections++;
        });
    }
    assert.ok(splits > 10 && interjections > 10, `fuzz exercises both rules (${splits}/${interjections})`);
});

test('chunkText parts are exactly sentences(text)', () => {
    for (const text of ['えっ、ちょっと待って！今の攻撃やばくない！？', '一つ目。二つ目！', '句点なし', '「引用」です。次へ。'])
        assert.deepEqual(chunkText(text).parts, sentences(text));
    assert.throws(() => chunkText('  '), /Empty speech/);
});

test('punctuationEnding and effectiveMode', () => {
    assert.equal(punctuationEnding('えっ、'), 'continue'); assert.equal(punctuationEnding('あっ'), 'continue');
    assert.equal(punctuationEnding('そうだなあ…'), 'hold'); assert.equal(punctuationEnding('いいね〜'), 'hold'); assert.equal(punctuationEnding('すごーー'), 'hold');
    assert.equal(punctuationEnding('本当？'), 'beat'); assert.equal(punctuationEnding('「星」'), 'beat'); assert.equal(punctuationEnding('おしまい。 '), 'beat');
    assert.equal(punctuationEnding('句点なし'), 'continue');
    assert.equal(effectiveMode({ speechDirection: 'jev' }), 'jev'); assert.equal(effectiveMode({ speechDirection: 'reaction' }), 'reaction');
    assert.equal(effectiveMode({ speechDirection: 'loud' }), 'off'); assert.equal(effectiveMode({}), 'off'); assert.equal(effectiveMode(undefined), 'off');
});

test('chunkDeliveryFor: one bump for interjection or ！, fast surprise/joy interjections, 〜 slows, deterministic', () => {
    assert.deepEqual(chunkDeliveryFor('えっ、', 'shock', { intensity: 'low' }), { family: 'surprise', intensity: 'mid', pace: 'fast' });
    assert.deepEqual(chunkDeliveryFor('わあ！', 'happy'), { family: 'joy', intensity: 'high', pace: 'fast' });
    assert.deepEqual(chunkDeliveryFor('なるほど、', 'thinking'), { family: 'think', intensity: 'mid', pace: 'slow' }, 'think interjection: bump but no speed-up');
    assert.deepEqual(chunkDeliveryFor('すごい！', 'surprised'), { family: 'surprise', intensity: 'high', pace: 'fast' }, 'capped at high');
    assert.deepEqual(chunkDeliveryFor('すごい！？', 'neutral'), { family: 'neutral', intensity: 'high', pace: 'normal' });
    assert.deepEqual(chunkDeliveryFor('やった！', 'neutral', { intensity: 'low' }), { family: 'neutral', intensity: 'mid', pace: 'normal' }, 'single bump, never two');
    assert.deepEqual(chunkDeliveryFor('いいね〜', 'happy'), { family: 'joy', intensity: 'mid', pace: 'slow' });
    assert.deepEqual(chunkDeliveryFor('のんびりしよう〜', 'thinking'), { family: 'think', intensity: 'low', pace: 'slow' }, 'pace floor');
    assert.deepEqual(chunkDeliveryFor('そっか…', 'neutral', { pace: 'fast' }), { family: 'neutral', intensity: 'mid', pace: 'normal' });
    assert.deepEqual(chunkDeliveryFor('静かに。', 'listen'), { family: 'neutral', intensity: 'mid', pace: 'normal' });
    assert.deepEqual(chunkDeliveryFor('静かに。', 'neutral', { intensity: 'extreme', pace: 'warp' }), { family: 'neutral', intensity: 'mid', pace: 'normal' }, 'invalid overrides use the preset default');
    assert.deepEqual(chunkDeliveryFor('えっ、', 'neutral', { interjection: false }), { family: 'neutral', intensity: 'mid', pace: 'normal' });
    for (const text of randomTexts(40, 3)) for (const r of ACTABLE) assert.deepEqual(chunkDeliveryFor(text, r), chunkDeliveryFor(text, r));
});

test('deliveryQuestions: exact keys, neutral-first candidates, nonverbal only with clips, no chunk text in instructions', () => {
    const flat = chunkText('なるほど、洗った服を床に置く案だと、歩くたびに小さな障害物が増えそう、きれいにしたはずの服を。えっ、本当に？').flat;
    assert.equal(flat.length, 5);
    assert.deepEqual(Object.keys(deliveryQuestions(flat.slice(0, 1))), ['delivery_intensity', 'delivery_pace', 'delivery_ending']);
    assert.deepEqual(Object.keys(deliveryQuestions(flat.slice(0, 2))), ['delivery_intensity', 'delivery_pace', 'delivery_ending', 'seg1_reaction']);
    for (const n of [3, 4, 5]) assert.equal(Object.keys(deliveryQuestions(flat.slice(0, n))).filter(k => k.startsWith('seg')).length, Math.min(3, n - 1));
    assert.equal(deliveryQuestions(flat, []).delivery_nonverbal, undefined);
    assert.equal(deliveryQuestions(flat, ['bogus']).delivery_nonverbal, undefined);
    assert.deepEqual(Object.keys(deliveryQuestions(flat, ['gasp', 'hmm']).delivery_nonverbal.criteria), ['none', 'gasp', 'hmm']);
    assert.deepEqual(Object.keys(deliveryQuestions(flat, ['laugh_small', 'laugh_big']).delivery_nonverbal.criteria), ['none', 'laugh_small', 'laugh_big']);
    const all = deliveryQuestions(flat.slice(0, 4), Object.keys(NONVERBAL));
    assert.equal(Object.keys(all).length, 7, 'worst case adds 7 choice keys');
    assert.deepEqual(Object.keys(all.delivery_nonverbal.criteria), ['none', ...Object.keys(NONVERBAL)]);
    assert.equal(all.delivery_nonverbal.criteria.gasp, 'Short surprised intake of breath before speaking');
    const first = { delivery_intensity: 'mid', delivery_pace: 'normal', delivery_ending: 'beat', delivery_nonverbal: 'none', seg1_reaction: 'neutral', seg2_reaction: 'neutral', seg3_reaction: 'neutral' };
    for (const [k, q] of Object.entries(all)) {
        assert.equal(q.type, 'choice', k); assert.equal(Object.keys(q.criteria)[0], first[k], k);
        for (const chunk of flat) assert.ok(!q.instructions.includes(chunk) && !Object.values(q.criteria).some(d => d.includes(chunk)), `${k} embeds ${chunk}`);
        const picked = validateAnswers({ answers: { [k]: answer(q.criteria, Object.keys(q.criteria)[0]) } }, { [k]: q });
        assert.equal(picked[k].choice, first[k]);
    }
    assert.deepEqual(all.seg2_reaction.criteria, JEV_REACTIONS);
    assert.match(all.seg2_reaction.instructions, /state\.delivery\.segments\[2\]/);
    assert.equal(all.delivery_intensity.instructions, 'How strongly should the host express the emotion of this exact utterance, in voice and avatar together? Prefer mid unless the words themselves are clearly subdued or clearly emphatic.');
    assert.deepEqual(all.delivery_ending.criteria, { beat: 'Settle with a short natural pause', continue: 'Energetic hand-off with almost no pause', hold: 'Trail off with a noticeable pause for effect or relief' });
});

test('readDelivery applies code thresholds and never trusts a low-confidence extra', () => {
    const flat = ['えっ、', 'ちょっと待って！', '今の攻撃', 'やばくない！？', 'ほら、', 'ね。'];
    const q = deliveryQuestions(flat.slice(0, 4), ['gasp']);
    const d0 = readDelivery(extras(q, { delivery_intensity: ['low', .54], delivery_pace: ['slow', .5], delivery_ending: ['hold', .49] }), flat, { reaction: 'happy', text: '平気。' });
    assert.equal(d0.intensity, null, '.54 intensity → null'); assert.equal(d0.pace, 'slow'); assert.equal(d0.ending, null);
    assert.equal(d0.source, 'jev'); assert.equal(d0.defaulted, false);
    assert.equal(readDelivery(extras(q, { delivery_intensity: ['low', .55] }), flat, { reaction: 'happy' }).intensity, 'low');
    assert.equal(readDelivery(extras(q, { delivery_intensity: ['high', .9] }), flat, { reaction: 'happy', text: 'いいね。' }).intensity, 'mid', 'high demoted without ！');
    assert.equal(readDelivery(extras(q, { delivery_intensity: ['high', .9] }), flat, { reaction: 'happy', text: 'いいね！' }).intensity, 'high');
    assert.equal(readDelivery(extras(q, { delivery_intensity: ['high', .9] }), flat, { reaction: 'surprised', text: 'いいね。' }).intensity, 'high');
    const nv = (conf, warranted) => readDelivery(extras(q, { delivery_nonverbal: ['gasp', conf] }), flat, { reaction: 'shock', warranted }).nonverbal;
    assert.equal(nv(.6, .7), 'gasp'); assert.equal(nv(.59, .9), 'none'); assert.equal(nv(.9, .69), 'none'); assert.equal(nv(.9, undefined), 'none');
    const segs = readDelivery(extras(q, { seg1_reaction: ['thinking', .49], seg2_reaction: ['troubled', .5] }), flat, { reaction: 'surprised' });
    assert.deepEqual(segs.reactions, ['surprised', 'surprised', 'troubled', 'troubled', 'troubled', 'troubled'], 'below .5 and index ≥ 4 inherit');
    const raw = readDelivery({ answers: { seg1_reaction: { type: 'choice', choice: 'listen', confidence: .99 }, delivery_pace: { type: 'choice', choice: 'warp', confidence: .99 } }, defaulted: false }, flat.slice(0, 2), { reaction: 'nod' });
    assert.deepEqual(raw.reactions, ['nod', 'nod'], 'local or unknown names are never taken'); assert.equal(raw.pace, null);
    const none = readDelivery(null, flat.slice(0, 3), { reaction: 'laugh', warranted: 1, text: 'あはは！' });
    assert.deepEqual(none, { source: 'jev', intensity: null, pace: null, ending: null, nonverbal: 'none', reactions: ['laugh', 'laugh', 'laugh'], defaulted: true });
    assert.equal(readDelivery({ answers: {}, defaulted: true }, flat, { reaction: 'nod' }).defaulted, true);
    assert.equal(readDelivery(extras(q, { delivery_intensity: ['bogus', .9] }), flat, { reaction: 'nod' }).defaulted, true, 'an invalid extra marks defaulted');
    assert.deepEqual(readDelivery(null, [], { reaction: 'listen' }).reactions, ['neutral']);
});

test('demoDelivery is a transparent keyword stand-in', () => {
    const a = demoDelivery('えっ、それはうれしいな。', ['えっ、', 'それはうれしいな。', 'ね。']);
    assert.deepEqual(a, { source: 'demo-rule', intensity: 'mid', pace: null, ending: null, nonverbal: 'none', reactions: ['surprised', 'happy', 'happy'], defaulted: false });
    assert.equal(a.reactions[0], demoReaction('えっ、それはうれしいな。'));
    assert.equal(demoDelivery('やった！見つけた！', ['やった！', '見つけた！']).intensity, 'high', 'two ！');
    assert.equal(demoDelivery('星を見つけたよ。', ['星を見つけたよ。']).intensity, 'high', 'excited');
    assert.equal(demoDelivery('すごい！', ['すごい！']).intensity, 'mid');
    assert.equal(demoDelivery('よかった、ほっとしたよ。', ['よかった、ほっとしたよ。']).pace, 'slow');
    assert.equal(demoDelivery('急いで行こう。', ['急いで行こう。']).pace, 'fast');
    assert.equal(demoDelivery('そうだなあ…', ['そうだなあ…']).ending, 'hold');
    assert.equal(demoDelivery('いいね〜', ['いいね〜']).ending, 'hold');
    assert.equal(demoDelivery('いいね。', ['いいね。']).ending, null);
});

const shockText = 'えっ、ちょっと待って！今の攻撃やばくない！？';

test('plan is null when direction is off', () => {
    for (const c of [{}, { speechDirection: 'off' }, { speechDirection: 'loud' }]) assert.equal(new SpeechDirector(c).plan(shockText, { reaction: 'shock' }, { clipKinds: ['gasp'] }), null);
});

test('reaction mode plan: exact chunks, interjection pause, tails and a gasp pre-clip only when available', () => {
    const d = new SpeechDirector({ speechDirection: 'reaction' });
    const p = d.plan(shockText, { reaction: 'shock' });
    assert.equal(p.mode, 'reaction'); assert.equal(p.source, 'reaction'); assert.equal(p.head, 'shock'); assert.equal(p.intensity, 'high');
    assert.equal(p.parts.length, 2);
    assert.deepEqual(p.parts[0].chunks.map(c => c.text), ['えっ、', 'ちょっと待って！']);
    assert.deepEqual(p.parts[0].chunks.map(c => c.start), [0, 3]);
    assert.deepEqual(p.parts[0].chunks.map(c => c.pauseAfterMs), [120, 0]);
    assert.equal(p.parts[0].chunks[0].interjection, true);
    assert.deepEqual(p.parts.map(x => x.tailMs), [80, 80]);
    assert.deepEqual(p.parts.map(x => x.head), ['shock', 'shock']);
    for (const part of p.parts) for (const c of part.chunks) {
        assert.deepEqual({ family: c.family, intensity: c.intensity, pace: c.pace }, chunkDeliveryFor(c.text, c.reaction), 'render-key parity');
        assert.equal(c.ending, punctuationEnding(c.text));
    }
    assert.ok(p.parts.every(x => x.clip === null && x.beats.length === 0));
    assert.equal(d.plan(shockText, { reaction: 'shock' }, { clipKinds: ['hmm'] }).parts[0].clip, null);
    const g = d.plan(shockText, { reaction: 'shock' }, { clipKinds: ['gasp', 'hmm'] });
    assert.deepEqual(g.parts[0].clip, { cls: 'gasp', position: 'pre' }); assert.equal(g.parts[1].clip, null);
    assert.equal(d.plan('はっ、ちょっと待って！今の攻撃やばくない！？', { reaction: 'shock' }, { clipKinds: ['gasp'] }).parts[0].clip, null, 'words already gasp');
    assert.equal(d.plan(shockText, { reaction: 'surprised' }, { clipKinds: ['gasp'] }).parts[0].clip, null, 'surprised carries no clip in reaction mode');
    const odd = d.plan('静かな夜だね。', { reaction: 'listen' });
    assert.equal(odd.head, 'neutral'); assert.equal(d.plan('静かな夜だね。', null).head, 'neutral');
    assert.equal(d.prepare(shockText).flat.length, 3);
});

test('embarrassed plans a laugh_small post-clip on the last part', () => {
    const d = new SpeechDirector({ speechDirection: 'reaction' });
    const text = 'そんなに褒められると照れるね。ありがとう、うれしいよ。';
    const p = d.plan(text, { reaction: 'embarrassed' }, { clipKinds: ['laugh_small'] });
    assert.equal(p.parts[0].clip, null); assert.deepEqual(p.parts[1].clip, { cls: 'laugh_small', position: 'post' });
    assert.equal(p.intensity, 'low'); assert.ok(p.parts.every(x => x.chunks.every(c => c.family === 'shy')));
    assert.equal(d.plan(text, { reaction: 'embarrassed' }).parts[1].clip, null);
    assert.equal(d.plan('そんなに褒められると照れるね。ありがとう笑', { reaction: 'embarrassed' }, { clipKinds: ['laugh_small'] }).parts[1].clip, null);
});

test('jev mode: seg reactions give calm beats (≤4), later chunks inherit, delivery drives voice, ending and clip', () => {
    const d = new SpeechDirector({ speechDirection: 'jev' });
    const text = 'なるほど、洗った服を床に置く案だと、歩くたびに小さな障害物が増えそう、きれいにしたはずの服を。うわっ、座れる収納箱なら、椅子と服の置き場を兼ねられるし、少し窮屈だけれど一つの家具に二つの仕事を頼めるね。';
    assert.deepEqual(d.prepare(text).chunks.map(x => x.length), [3, 3]);
    const delivery = { source: 'jev', intensity: null, pace: null, ending: 'hold', nonverbal: 'breath_in', reactions: ['happy', 'shock', 'thinking', 'nod'], defaulted: false };
    const p = d.plan(text, { reaction: 'happy', delivery }, { clipKinds: ['breath_in'] });
    assert.equal(p.source, 'jev'); assert.equal(p.head, 'happy');
    assert.deepEqual(p.parts.flatMap(x => x.chunks.map(c => c.reaction)), ['happy', 'shock', 'thinking', 'nod', 'nod', 'nod']);
    assert.deepEqual(p.parts[0].beats, [{ chunk: 1, reaction: 'surprised' }, { chunk: 2, reaction: 'thinking' }]);
    assert.deepEqual(p.parts[1].beats, []);
    assert.deepEqual(p.parts.map(x => x.head), ['happy', 'nod']);
    const beats = p.parts.flatMap(x => x.beats);
    assert.ok(beats.length <= DIRECTION_LIMITS.maxBeats && beats.every(b => !REACTIONS[b.reaction].big));
    assert.equal(p.parts[0].chunks[1].family, 'surprise', 'the chunk voice follows its own (big) preset; only beats are calmed');
    assert.equal(p.parts[1].chunks.at(-1).ending, 'hold'); assert.equal(p.parts[1].tailMs, 220);
    assert.equal(p.parts[0].chunks.at(-1).ending, 'beat'); assert.equal(p.parts[0].tailMs, 80);
    assert.deepEqual(p.parts[0].clip, { cls: 'breath_in', position: 'pre' });
    assert.equal(d.plan(text, { reaction: 'happy', delivery: { ...delivery, nonverbal: 'gasp' } }, { clipKinds: ['gasp'] }).parts[0].clip, null, 'gasp does not fit happy');
    assert.equal(d.plan(text, { reaction: 'happy', delivery: { ...delivery, nonverbal: 'none' } }, { clipKinds: ['breath_in'] }).parts[0].clip, null);
    const low = d.plan(text, { reaction: 'happy', delivery: { ...delivery, intensity: 'low', pace: 'fast', ending: 'continue' } });
    assert.equal(low.intensity, 'low'); assert.ok(low.parts.every(x => x.intensity === 'low'));
    assert.equal(low.parts[1].tailMs, 0);
    for (const part of low.parts) for (const c of part.chunks) assert.deepEqual({ family: c.family, intensity: c.intensity, pace: c.pace }, chunkDeliveryFor(c.text, c.reaction, { intensity: 'low', pace: 'fast' }));
    const seg0 = d.plan(text, { reaction: 'troubled', delivery: { ...delivery, reactions: ['laugh', 'troubled'] } });
    assert.equal(seg0.parts[0].chunks[0].reaction, 'troubled', 'segment 0 always acts the gate reaction');
    const plain = d.plan(text, { reaction: 'happy' }, { clipKinds: ['breath_in'] });
    assert.equal(plain.source, 'reaction'); assert.ok(plain.parts.every(x => x.clip === null && x.beats.length === 0));
    const demo = demoDelivery(shockText, d.prepare(shockText).flat.slice(0, 4));
    assert.equal(d.plan(shockText, { reaction: demoReaction(shockText), delivery: demo }).source, 'demo-rule');
    assert.equal(new SpeechDirector({ speechDirection: 'reaction' }).plan(text, { reaction: 'happy', delivery }).parts[0].beats.length, 0, 'reaction mode ignores Jev delivery');
});

test('pause caps: boundary ≤ 300, inner sum ≤ 600, scaled proportionally when over', () => {
    const d = new SpeechDirector({ speechDirection: 'reaction' });
    const text = 'なるほど、洗った服を床に置く案だと、歩くたびに小さな障害物が増えそう、きれいにしたはずの服を。';
    assert.deepEqual(d.plan(text, { reaction: 'neutral' }).parts[0].chunks.map(c => c.pauseAfterMs), [150, 30, 0]);
    assert.deepEqual(d.plan(text, { reaction: 'happy' }).parts[0].chunks.map(c => c.pauseAfterMs), [100, 30, 0]);
    const saved = { ...DIRECTION_LIMITS };
    try {
        DIRECTION_LIMITS.maxPausesPerPartMs = 90;
        assert.deepEqual(d.plan(text, { reaction: 'neutral' }).parts[0].chunks.map(c => c.pauseAfterMs), [75, 15, 0]);
        DIRECTION_LIMITS.maxBoundaryPauseMs = 20;
        assert.deepEqual(d.plan(text, { reaction: 'neutral' }).parts[0].chunks.map(c => c.pauseAfterMs), [20, 20, 0]);
    } finally { Object.assign(DIRECTION_LIMITS, saved); }
    const rnd = mulberry(11), modes = ['reaction', 'jev'];
    for (const [n, t] of [...demoTexts(), ...randomTexts(300, 5)].entries()) {
        const mode = modes[n % 2], pickOf = xs => xs[Math.floor(rnd() * xs.length)];
        const delivery = { source: 'jev', intensity: pickOf([null, ...INTENSITIES]), pace: pickOf([null, ...PACES]), ending: pickOf([null, ...ENDINGS]), nonverbal: pickOf(['none', ...Object.keys(NONVERBAL)]), reactions: Array.from({ length: 4 }, () => pickOf(ACTABLE)), defaulted: false };
        const p = new SpeechDirector({ speechDirection: mode }).plan(t, { reaction: pickOf(ACTABLE), delivery }, { clipKinds: Object.keys(NONVERBAL) });
        assert.equal(assertCovers(p, t), p);
        assert.ok(p.parts.filter(x => x.clip).length <= 1, 'at most one clip per turn');
        p.parts.forEach((x, i) => { if (x.clip) assert.equal(x.clip.position === 'pre' ? 0 : p.parts.length - 1, i, 'pre on part 0, post on the last part'); });
        for (const part of p.parts) {
            assert.equal(part.chunks.at(-1).pauseAfterMs, 0);
            assert.ok(part.chunks.every(c => c.pauseAfterMs >= 0 && c.pauseAfterMs <= 300));
            assert.ok(part.chunks.reduce((s, c) => s + c.pauseAfterMs, 0) <= 600);
            assert.ok([0, 80, 220].includes(part.tailMs), String(part.tailMs));
            assert.ok(part.beats.length <= 4 && part.beats.every(b => b.chunk >= 1 && !REACTIONS[b.reaction].big && !REACTIONS[b.reaction].local));
        }
    }
});

test('assertCovers throws PLAN_INVARIANT for any tampered plan', () => {
    const d = new SpeechDirector({ speechDirection: 'reaction' });
    const p = d.plan(shockText, { reaction: 'shock' });
    assert.equal(assertCovers(p, shockText), p);
    const cases = [
        x => { x.parts[0].chunks[0].text = 'えっ！'; },
        x => { x.parts[0].chunks[1].text += '！'; },
        x => { x.parts[0].chunks.reverse(); },
        x => { x.parts.pop(); },
        x => { x.parts[1].text = 'やばい！'; x.parts[1].chunks[0].text = 'やばい！'; },
        x => { x.parts[0].chunks[1].start = 2; },
        x => { x.parts[0].chunks.push({ text: '', start: 11 }); },
        x => { x.parts[0].chunks = []; },
        x => { x.parts = null; },
    ];
    for (const mutate of cases) { const x = tamper(p); mutate(x); assert.throws(() => assertCovers(x, shockText), code); }
    assert.throws(() => assertCovers(null, shockText), code);
    assert.throws(() => assertCovers(p, '別の話。'), code);
    assert.throws(() => assertCovers(p, ''), code);
});

test('neutralPart shape', () => {
    const d = new SpeechDirector({});
    assert.deepEqual(d.neutralPart('こんばんは。'), { index: 0, text: 'こんばんは。', head: 'neutral', intensity: 'mid',
        chunks: [{ text: 'こんばんは。', start: 0, reaction: 'neutral', family: 'neutral', intensity: 'mid', pace: 'normal', ending: 'beat', interjection: false, pauseAfterMs: 0 }], clip: null, beats: [], tailMs: 0 });
    assert.equal(d.neutralPart('次へ。', 1).index, 1);
    assert.equal(assertCovers({ parts: [d.neutralPart('こんばんは。')] }, 'こんばんは。').parts.length, 1);
});
