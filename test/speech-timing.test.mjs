import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSpeechTiming, speechTiming, cropSpeechTiming } from '../src/speech-timing.mjs';
import { writeWav, readWav, trimSilenceRange } from '../src/wav.mjs';
import { conditionSpeechUnit, partAudio } from '../src/audio-bus.mjs';
import { SpeechVisemeClock, validLipSync, visemeAt, MAX_LIP_CUES } from '../public/speech-visemes.mjs';

const rate = 24000, frame = 256 / rate, milliseconds = count => count * frame * 1000;
const wave = (ms, ranges = [[0, ms]]) => writeWav(Float32Array.from({ length: Math.round(ms / 1000 * rate) }, (_, index) => {
    const at = index / rate * 1000;
    return ranges.some(([from, to]) => at >= from && at < to) ? Math.sin(index * .1) * .2 : 0;
}), rate);
const query = () => ({ speedScale: 1, prePhonemeLength: 10 * frame, postPhonemeLength: 8 * frame,
    accent_phrases: [{ moras: [{ vowel: 'a', vowel_length: 15 * frame, consonant: 'k', consonant_length: 5 * frame },
        { vowel: 'i', vowel_length: 10 * frame }], pause_mora: { vowel: 'pau', vowel_length: 12 * frame } }] });
function timed(q = query(), ms = milliseconds(60), engine = 'voicevox', ranges = [[milliseconds(10), milliseconds(40)]]) {
    const bytes = wave(ms, ranges); attachSpeechTiming(bytes, q, engine); return { bytes, lipSync: speechTiming(bytes) };
}
const near = (value, expected) => assert.ok(Math.abs(value - expected) < .002, `${value} ≠ ${expected}`);

test('VOICEVOX uses decoder frame durations, consonant lead, pause and speed without editing query', () => {
    const q = query(), saved = structuredClone(q), { lipSync } = timed(q);
    assert.deepEqual(q, saved); assert.equal(lipSync.source, 'query'); assert.equal(validLipSync(lipSync), true);
    assert.deepEqual(lipSync.cues.map(cue => cue.vowel), ['n', 'a', 'a', 'i', 'n', 'n']);
    for (const [index, end] of [10, 15, 30, 40, 52, 60].entries()) near(lipSync.cues[index].endMs, milliseconds(end));
    assert.equal(visemeAt(lipSync, milliseconds(12)).a, .45, 'consonant anticipates the vowel without full jaw opening');
    assert.equal(visemeAt(lipSync, milliseconds(33)).i, 1);
    assert.equal(visemeAt(lipSync, milliseconds(45)).n, 1);
    q.speedScale = 2;
    const fast = timed(q, milliseconds(30), 'voicevox', [[milliseconds(5), milliseconds(20)]]).lipSync;
    assert.equal(fast.source, 'query');
    for (const [index, end] of [5, 7, 15, 20, 26, 30].entries()) near(fast.cues[index].endMs, milliseconds(end));
    q.pauseLength = 18 * frame; q.pauseLengthScale = 2;
    near(timed(q, milliseconds(42)).lipSync.cues[4].endMs, milliseconds(38));
});

test('query accounts for interrogative upspeak, nasal/closure and devoiced vowels', () => {
    const q = { speedScale: 1, prePhonemeLength: 0, postPhonemeLength: 0, accent_phrases: [{
        moras: ['N', 'cl', 'U', 'o'].map(vowel => ({ vowel, vowel_length: 10 * frame, pitch: vowel === 'o' ? 4 : 0 })), is_interrogative: true }] };
    const { lipSync } = timed(q, milliseconds(54), 'voicevox', [[0, milliseconds(54)]]);
    assert.equal(lipSync.source, 'query'); assert.deepEqual(lipSync.cues.map(cue => cue.vowel), ['n', 'n', 'u', 'o', 'o']);
    assert.equal(visemeAt(lipSync, milliseconds(25)).u, .6);
    assert.equal(visemeAt(lipSync, milliseconds(5)).n, 1);
});

test('Aivis uses engine reading and measured silent intervals while labeling timing as estimated', () => {
    const q = { accent_phrases: [{ moras: ['i', 'pau', 'o'].map(vowel => ({ vowel, vowel_length: 0 })) }] };
    const { lipSync } = timed(q, 1200, 'aivisspeech', [[100, 500], [700, 1100]]);
    assert.equal(lipSync.source, 'reading-estimate'); assert.equal(validLipSync(lipSync), true);
    assert.equal(visemeAt(lipSync, 0).n, 1); assert.equal(visemeAt(lipSync, 600).n, 1); assert.equal(visemeAt(lipSync, 1199).n, 1);
    assert.equal(visemeAt(lipSync, 300).i, 1); assert.equal(visemeAt(lipSync, 900).o, 1);
    assert.equal(lipSync.cues.some(cue => cue.vowel === 'a'), false, 'written kanji never supplies a pseudo vowel');
    const silent = timed(q, 400, 'aivisspeech', []).lipSync;
    assert.equal(visemeAt(silent, 200).n, 1);
});

test('invalid/missing/oversized queries leave the original WAV playable; unsupported TTS falls back', () => {
    const bytes = wave(400), original = Buffer.from(bytes);
    for (const q of [null, {}, { accent_phrases: [{ moras: [{ vowel: 'a', vowel_length: Infinity }] }] },
        { accent_phrases: [{ moras: Array(1501).fill({ vowel: 'a', vowel_length: 0 }) }] }]) {
        const fresh = Buffer.from(bytes); assert.equal(attachSpeechTiming(fresh, q), fresh);
        assert.deepEqual(fresh, original);
    }
    assert.equal(speechTiming(bytes), null); assert.equal(validLipSync(null), false);
    const base = timed().lipSync;
    for (const patch of [{ durationMs: Infinity }, { durationMs: 45001 }, { cues: Array(MAX_LIP_CUES + 1).fill(base.cues[0]) },
        { cues: [{ startMs: -1, endMs: 10, vowel: 'a' }] }, { cues: [{ startMs: 0, endMs: 10, vowel: 'a', strength: NaN }] },
        { cues: [{ startMs: 0, endMs: 100, vowel: 'a' }, { startMs: 50, endMs: 150, vowel: 'i' }] }])
        assert.equal(validLipSync({ ...base, ...patch }), false);
});

test('conditioning keeps exact trim offsets and finalized clips/pauses cannot displace mouth cues', () => {
    const { bytes, lipSync } = timed(), wav = readWav(bytes), crop = trimSilenceRange(wav.samples, rate);
    const conditioned = conditionSpeechUnit(wav.samples, rate, { lipSync });
    assert.equal(conditioned.pcm.length, crop.end - crop.start);
    near(conditioned.lipSync.cues.find(cue => cue.vowel === 'i').startMs, milliseconds(30) - crop.start / rate * 1000);
    const second = { pcm: new Float32Array(2400), lipSync: null, pauseAfterMs: 0 };
    const bus = partAudio({ rate, units: [{ ...conditioned, pauseAfterMs: 120 }, second],
        clip: { cls: 'gasp', position: 'pre', pcm: new Float32Array(4800) }, tailMs: 80 });
    const full = bus.full, bare = bus.bare();
    assert.equal(full.lipSync.source, 'mixed');
    const fullI = full.lipSync.cues.find(cue => cue.vowel === 'i'), bareI = bare.lipSync.cues.find(cue => cue.vowel === 'i');
    near(fullI.startMs - bareI.startMs, 260);
    assert.equal(visemeAt(full.lipSync, 100), null, 'wordless clip follows its own measured audio amplitude');
    assert.equal(visemeAt(full.lipSync, 230).n, 1, 'clip gap is silent');
    const pause = full.timeline.units[0].endMs + 50;
    assert.equal(visemeAt(full.lipSync, pause).n, 1);
    assert.equal(visemeAt(full.lipSync, full.timeline.units[1].startMs + 20), null, 'cached phrase without metadata remains playable');
    assert.equal(visemeAt(full.lipSync, full.durationMs - 30).n, 1);
    const post = partAudio({ rate, units: [conditioned], clip: { cls: 'laugh', position: 'post', pcm: new Float32Array(4800) } }).full;
    assert.equal(visemeAt(post.lipSync, post.timeline.clip.startMs + 20), null);
    assert.equal(cropSpeechTiming(null, 0, 100), null);
});

test('playback clock waits through preparation, survives suspension and resets on cancellation/new speech', () => {
    const clock = new SpeechVisemeClock(), { lipSync } = timed();
    clock.prepare({ role: 'host', lipSync });
    assert.equal(clock.sample(90).n, 1, 'loading/ACK time is not speech time');
    clock.start(90);
    const position = 90 + milliseconds(33) / 1000;
    assert.equal(clock.sample(position).i, 1);
    assert.deepEqual(clock.sample(position), clock.sample(position), 'suspended audio time stays on its own vowel');
    assert.equal(clock.sample(100).n, 1, 'late animation frame catches up to playback end');
    clock.reset(); assert.equal(clock.sample(position), null);
    clock.prepare({ role: 'host', lipSync }); assert.equal(clock.sample(position).n, 1);
    clock.start(150); assert.equal(clock.sample(150).n, 1);
    clock.prepare({ role: 'comment', lipSync }); clock.start(200); assert.equal(clock.sample(200.3).n, 1);
    clock.prepare({ lipSync: { bad: true } }); assert.equal(clock.sample(0), null);
    clock.prepare({ kind: 'stream' }); assert.equal(clock.sample(12), null);
});
