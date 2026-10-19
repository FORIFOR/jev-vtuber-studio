// Who speaks as Noa, and whether she reacts to comments (docs/CONTROL.md; operator 2026-10-19, NOA Studio Phase 1).
// voice 'ai': the show generates, gates (Jev.speech) and voices every line as before. voice 'human': a person speaks
// through the OBS input OBS_HUMAN_MIC_SOURCE (any voice changer sits before it); no line is generated, gated or voiced
// meanwhile, and the person's speech is not gated (operator decision 2026-10-19). Every handoff is audited.
// How the person is heard depends on HUMAN_VOICE_MODE (src/human-voice.mjs): resynth keeps the OBS mic muted and speaks
// their transcribed words in Noa's own TTS voice; passthrough / rvc open the OBS mic input.
// Safety rule: the AI voice and the human mic are never on air together. A handoff that cannot be confirmed leaves
// both silent rather than both open: AI -> human silences the AI first; human -> AI opens the AI only after OBS has
// confirmed the mic is muted.
import { opensMic } from './human-voice.mjs';
import { REACTIONS } from '../public/avatar-rig.mjs';
import { nextListening } from '../public/hotkeys.mjs';

// Who speaks as Noa: the AI, a person, or nobody ('none', MUTE NOA / F9, Phase 4: the AI is silent and the mic muted).
export const VOICE_OWNERS = Object.freeze(['ai', 'human', 'none']);
// Listening (docs/CONTROL.md, docs/COLLAB.md): comments only (no voice call), muted, or with a voice-call partner
// (Phase 2): the partner first, comments first, both by age, or the partner only.
export const LISTENING_MODES = Object.freeze(['comments', 'muted', 'discord_first', 'comments_first', 'both', 'discord_only']);
/** Whether Noa takes up viewer comments in this mode (otherwise they are only shown in the chat box). */
export const takesComments = mode => ['comments', 'discord_first', 'comments_first', 'both'].includes(mode);
/** Whether Noa listens to the voice-call partner in this mode. */
export const hearsPartner = mode => ['discord_first', 'comments_first', 'both', 'discord_only'].includes(mode);
/** Whether Noa's own talk waits while the partner is in the conversation (the partner leads these modes). */
export const partnerLeads = mode => ['discord_first', 'both', 'discord_only'].includes(mode);
/** The state a show starts from (Engine.control). */
// avatar (Phase 6): 'auto' (the speech and events act, as always) or 'manual' (the operator's face holds; face: a preset).
export const initialControl = () => ({ voice: 'ai', listening: 'comments', since: null, by: null, micError: null, switching: false, latency: null, avatar: 'auto', face: null });
/** Faces the operator can hold in manual mode (public/avatar-rig.mjs presets). */
export const MANUAL_FACES = Object.freeze(['neutral', 'happy', 'laugh', 'excited', 'surprised', 'troubled', 'thinking', 'embarrassed'].filter(f => Object.hasOwn(REACTIONS, f)));
// obs-websocket EventSubscription.InputVolumeMeters (a high-volume event, about every 50 ms).
const INPUT_VOLUME_METERS = 1 << 16;
const LEVEL_EVERY_MS = 66;
const SAME_PRESS_MS = 250; // the same switch again within this is one press (a held or bouncing key)
const SENTENCE_WAIT_MS = 4000; // HANDOFF_TIMING=sentence: the longest the line on air may finish before the handoff
const SPEAKING_LEVEL = .15; // a mic level above this means the person is speaking (resume preparation waits)
const median = xs => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

export class ControlError extends Error {
    constructor(message, status = 409) { super(message); this.status = status; }
}

export class Control {
    constructor(c, { engine, obs, audit, MeterOBS = null, now = Date.now }) {
        Object.assign(this, { c, engine, obs, audit, MeterOBS, now });
        this.meter = null; this.chain = Promise.resolve(); this.lastPress = null;
        this.seq = 0; this.silence = null; this.resumeAt = null; this.samples = { silentMs: [], resumeMs: [] };
        // Stop, emergency stop and a new show always end a handoff: the mic is muted and the AI owns the voice again. The
        // mic meter runs for the whole show, so Noa's mouth follows the person from their first syllable (Phase 4).
        engine.onControlReset = reason => { void this.micOff(reason); if (reason === 'start') { this.samples = { silentMs: [], resumeMs: [] }; this.startMeter(); } else this.stopMeter(); };
        // AI resume time: from the press to the first line that starts playing.
        engine.on?.('event', ev => { if (ev.type === 'speech_started' && this.resumeAt !== null) { this.sample('resumeMs', this.now() - this.resumeAt); this.resumeAt = null; } });
    }
    get state() { return this.engine.control; }
    /** Whether the person's voice opens the OBS mic input (passthrough / rvc), not resynth. */
    micMode() { return opensMic(this.c.humanVoiceMode); }
    /** Whether a person can take the voice: resynth needs no OBS mic; the others need OBS_HUMAN_MIC_SOURCE. */
    humanAvailable() { return !this.micMode() || !!this.c.obsHumanMicSource; }
    /** Switches run one at a time in order (a press during a switch waits for it); the same press within 250 ms is one. */
    setVoice(to, by = 'operator') {
        if (!VOICE_OWNERS.includes(to)) return Promise.reject(new ControlError('声の担当は ai / human / none から選んでください。', 400));
        const t = this.now();
        if (this.lastPress?.to === to && t - this.lastPress.at < SAME_PRESS_MS) return this.lastPress.run;
        const run = this.chain.then(() => this.apply(to, by));
        this.chain = run.catch(() => { });
        // A refused press is not remembered: pressing again (e.g. once the show has started) is a new press.
        this.lastPress = { to, at: t, run };
        run.catch(() => { if (this.lastPress?.run === run) this.lastPress = null; });
        return run;
    }
    async apply(to, by) {
        if (to === this.state.voice) return this.state;
        this.state.switching = true; this.engine.event('state', this.engine.status());
        try { return to === 'ai' ? await this.toAi(by) : await this.away(to, by); }
        finally { this.state.switching = false; this.engine.event('state', this.engine.status()); }
    }
    /** AI or nobody -> a person, AI -> nobody, or a person -> nobody. */
    async away(to, by) {
        if (to === 'human' && !this.humanAvailable()) throw new ControlError('人間マイクのOBSソース（OBS_HUMAN_MIC_SOURCE）が未設定です。設定で選ぶか、声の出し方を「コハクで読み直し」にしてから切り替えてください。');
        if (!this.engine.running) throw new ControlError('番組の開始後に切り替えられます。');
        const from = this.state.voice;
        // A person going quiet: their mic is muted (and confirmed) before anything else.
        if (from === 'human') await this.muteMic(to, from, by);
        // 1. No new line starts from here on (the state is checked by every turn).
        Object.assign(this.state, { voice: to, since: this.now(), by, micError: null });
        if (from === 'ai') {
            // HANDOFF_TIMING=sentence: the line on air may finish (at most 4 s); immediate: it fades out now.
            if (this.c.handoffTiming === 'sentence' && this.engine.pending?.started && !this.engine.pending.human) {
                const until = this.now() + SENTENCE_WAIT_MS;
                while (this.engine.pending && this.now() < until) await new Promise(r => setTimeout(r, 50));
            }
            this.silence = { seq: ++this.seq, at: this.now() };
        }
        // 2. The line on air (faded out on the stage) and any prepared one stop; the stage reports silence (handoff).
        this.engine.humanTakeover(to, from);
        if (from === 'ai') this.engine.event('handoff', { seq: this.silence.seq });
        // 3. Open the person's mic (resynth: never; their words air in Noa's TTS voice). If OBS cannot confirm it, the AI
        // stays silent: silence is safer than an unreviewed line.
        if (to === 'human' && this.micMode()) {
            try { await this.obs.setHumanMic(this.c.obsHumanMicSource, true); }
            catch (e) { this.state.micError = e.message; this.engine.event('notice', { message: '人間マイクをONにできませんでした。OBSを確認してください（AIは停止したままです）。' }); }
            this.startMeter();
        }
        this.audit.log('control_handoff', { voice: to, from, by, mode: this.c.humanVoiceMode || 'passthrough', micError: this.state.micError });
        return this.state;
    }
    async toAi(by) {
        const from = this.state.voice, held = this.state.since ? this.now() - this.state.since : 0;
        // Mute the person first and wait for OBS to confirm; without that the AI does not resume (no two voices at once).
        // From nobody the mic was already confirmed muted (or never opened).
        if (from === 'human') await this.muteMic('ai', from, by);
        this.resumeAt = this.now();
        Object.assign(this.state, { voice: 'ai', since: this.now(), by, micError: null });
        this.engine.aiResume(held);
        this.audit.log('control_handoff', { voice: 'ai', from, by, heldMs: held });
        return this.state;
    }
    /** Any configured mic input is muted, resynth included (it may have been opened by hand or before a mode change). */
    async muteMic(to, from, by) {
        try { if (this.c.obsHumanMicSource) await this.obs.setHumanMic(this.c.obsHumanMicSource, false); }
        catch (e) {
            this.state.micError = e.message;
            this.audit.log('control_handoff_refused', { voice: to, from, by, micError: e.message });
            throw new ControlError(to === 'ai' ? '人間マイクをOFFにできないため、AIに戻していません。OBSでマイクを止めてから、もう一度押してください。' : '人間マイクをOFFにできないため、切り替えていません。OBSでマイクを止めてから、もう一度押してください。');
        }
    }
    /** The stage faded the AI voice out after a handoff (renderer report): time from the press to silence. */
    reportSilent(seq) {
        if (!this.silence || this.silence.seq !== Number(seq)) return false;
        this.sample('silentMs', this.now() - this.silence.at); this.silence = null;
        return true;
    }
    sample(kind, ms) {
        const xs = this.samples[kind]; xs.push(Math.round(ms)); if (xs.length > 10) xs.shift();
        this.state.latency = { silentMs: this.samples.silentMs.at(-1) ?? null, resumeMs: this.samples.resumeMs.at(-1) ?? null, silentP50: median(this.samples.silentMs), resumeP50: median(this.samples.resumeMs) };
        this.audit.log('control_latency', { kind, ms: Math.round(ms) });
        this.engine.event('state', this.engine.status());
    }
    /** Avatar Controller (Phase 6): manual holds the operator's face over every automatic reaction; auto gives it back. */
    setAvatar(to, face = null, by = 'operator') {
        if (!['auto', 'manual'].includes(to)) throw new ControlError('表情は auto か manual を選んでください。', 400);
        if (face !== null && face !== undefined && !MANUAL_FACES.includes(face)) throw new ControlError(`表情は ${MANUAL_FACES.join(' / ')} から選んでください。`, 400);
        const from = { avatar: this.state.avatar, face: this.state.face };
        this.state.avatar = to;
        this.state.face = to === 'manual' ? (face || this.state.face || 'neutral') : null;
        if (from.avatar !== to || from.face !== this.state.face) {
            this.audit.log('control_avatar', { avatar: to, face: this.state.face, by });
            this.engine.event('state', this.engine.status());
        }
        return this.state;
    }
    /** A hotkey (public/hotkeys.mjs names), resolved on the current state: the same from the Studio, the panel and the
     * global helper (scripts/global-hotkeys.mjs). */
    async hotkey(name, by = 'hotkey') {
        const s = this.state;
        switch (name) {
            case 'voice-toggle': return this.setVoice(s.voice === 'human' ? 'ai' : 'human', by);
            case 'take-over': return this.setVoice('human', by);
            case 'mute': return this.setVoice('none', by);
            case 'resume': return this.setVoice('ai', by);
            case 'listening-toggle': return this.setListening(nextListening(s.listening), by);
            case 'avatar-toggle': return this.setAvatar(s.avatar === 'manual' ? 'auto' : 'manual', null, by);
            case 'game-toggle':
                if (!this.gameRunner?.enabled) throw new ControlError('この番組にはAIが操作するゲームがありません。');
                await this.gameRunner.switchPlayer();
                return s;
            default: throw new ControlError('不明なショートカットです。', 400);
        }
    }
    setListening(to, by = 'operator') {
        if (!LISTENING_MODES.includes(to)) throw new ControlError(`聞くものは ${LISTENING_MODES.join(' / ')} から選んでください。`, 400);
        if (to === this.state.listening) return this.state;
        const from = this.state.listening;
        this.state.listening = to;
        this.audit.log('control_listening', { listening: to, from, by });
        this.engine.event('state', this.engine.status());
        return this.state;
    }
    /** Stop / emergency / new show: mute the mic (best effort; a failure is reported, never thrown). */
    async micOff(reason) {
        if (!this.c.obsHumanMicSource) return;
        try { await this.obs.setHumanMic(this.c.obsHumanMicSource, false); }
        catch (e) {
            this.audit.log('control_mic_off_failed', { reason, error: e.message });
            this.engine.event('notice', { message: '人間マイクをOFFにできませんでした。OBSでマイクがミュートか確認してください。' });
        }
    }
    /** While a person speaks, Noa's mouth follows the mic level (OBS volume meters on a separate connection, so the
     * Studio's own OBS connection keeps subscribing to no events), from the show's start. Best effort: no meter, no
     * mouth movement. */
    startMeter() {
        if (this.meter || !this.c.obsHumanMicSource || !this.MeterOBS) return;
        const meter = new this.MeterOBS(this.c), name = this.c.obsHumanMicSource;
        meter.eventSubscriptions = INPUT_VOLUME_METERS;
        let last = 0;
        meter.onEvent = ({ eventType, eventData }) => {
            if (eventType !== 'InputVolumeMeters' || this.meter !== meter || this.state.voice !== 'human') return;
            const input = eventData?.inputs?.find(x => x.inputName === name), t = this.now();
            if (!input || t - last < LEVEL_EVERY_MS) return;
            last = t;
            // inputLevelsMul: per channel [magnitude, peak, input peak], linear. The magnitude is scaled as the stage scales
            // the RMS of Noa's own voice (public/stage.mjs levelFromAudio), so the mouth opens alike.
            const magnitude = Math.max(0, ...(input.inputLevelsMul || []).map(ch => Number(ch?.[0]) || 0));
            const level = Math.min(1, magnitude * 7);
            if (level > SPEAKING_LEVEL) this.engine.humanActiveAt = t;
            this.engine.event('human_level', { level });
        };
        this.meter = meter;
        meter.connect().catch(() => { if (this.meter === meter) this.meter = null; });
    }
    stopMeter() { const m = this.meter; this.meter = null; m?.close?.(); }
}
