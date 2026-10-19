// The capture page (docs/COLLAB.md, docs/HUMAN_VOICE.md; NOA Studio Phases 2-3). Open in Chrome on the streaming PC
// and leave it open. Two independent captures, each cut into utterances at a pause (collab-vad.mjs) and sent to the
// Studio as WAVs, transcribed locally:
// - the voice-call partner: the input Discord's output goes to (BlackHole 16ch); Noa answers them;
// - the person behind Noa ("中の人のマイク", HUMAN_VOICE_MODE=resynth): their real mic; while they have Noa's voice
//   their words are spoken again in Noa's TTS voice (the Studio ignores it, untranscribed, while the AI speaks).
// Admin only.
import { Segmenter, downsample, encodeWav } from './collab-vad.mjs';

const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
const admin = fragment.get('admin') || sessionStorage.getItem('jvs-admin') || '';
if (fragment.get('admin')) { sessionStorage.setItem('jvs-admin', admin); history.replaceState(null, '', location.pathname); }

async function post(path, body, type = 'application/json') {
    const r = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': type }, body });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
    return data;
}
const REASONS = { silence: '無音', too_short: '短すぎ', too_long: '長すぎ', hallucination: '聞き取れず', echo: 'ノアの声の戻り', not_listening: '聞くモードではない', human_voice: '人間が話し中（履歴のみ）', closing: 'お別れ中', not_running: '番組の開始前', local_gate: '安全チェックで除外', ai_voice: 'AIが話す番（文字にしていません）', not_resynth: '読み直しモードではない' };

/** One capture: { id: element prefix, segment: endpoint, speaking: endpoint or null, accepted: log note, pick(devices), warn(label) }. */
function capture({ id, segment, speaking, accepted, pick, warn }) {
    const el = k => $(`${id}-${k}`), DEVICE_KEY = `jvs-${id}-device`, THRESHOLD_KEY = `jvs-${id}-threshold`;
    let stream = null, ctx = null, node = null, segmenter = null, sending = Promise.resolve();
    const state = text => { el('state').textContent = text; };
    const say = on => speaking ? post(speaking, JSON.stringify({ on })).catch(() => { }) : Promise.resolve();
    function log(text, note = '') {
        const li = document.createElement('li'), small = document.createElement('small');
        small.textContent = `${new Date().toLocaleTimeString('ja-JP')}${note ? ` · ${note}` : ''}`;
        li.append(small, document.createTextNode(text)); el('log').prepend(li);
        while (el('log').children.length > 30) el('log').lastChild.remove();
    }
    function send(pcm) {
        const wav = encodeWav(pcm);
        sending = sending.then(async () => {
            try {
                const r = await post(segment, wav, 'audio/wav');
                if (r.text) log(r.text, r.accepted ? `${accepted}${r.sttMs ? ` · 認識 ${r.sttMs} ms` : ''}` : REASONS[r.reason] || r.reason);
                else if (r.reason !== 'ai_voice') log('（発言なし）', REASONS[r.reason] || r.reason || '');
            } catch (e) { log('（聞き取れませんでした）', e.message); }
        });
    }
    const warnDevice = () => { const o = el('device').selectedOptions[0]; if (el('warn')) el('warn').hidden = !warn(o?.textContent || ''); };
    async function listDevices() {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
        const saved = localStorage.getItem(DEVICE_KEY), sel = el('device');
        sel.replaceChildren(...devices.map(d => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || '入力'; return o; }));
        const chosen = devices.find(d => d.deviceId === saved) || pick(devices);
        if (chosen) sel.value = chosen.deviceId;
        warnDevice();
    }
    const markThreshold = () => { el('mark').style.left = `${Math.min(100, Number(el('threshold').value) / .08 * 100)}%`; };
    async function start() {
        if (!admin) { state('Studio から開いてください（管理者の情報がありません）'); return; }
        el('start').disabled = true;
        try {
            const deviceId = el('device').value;
            // No browser processing: Discord already processed the partner; a mic is better left natural for whisper.
            stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
            await listDevices();
            const used = stream.getAudioTracks()[0]?.getSettings().deviceId; if (used) { el('device').value = used; localStorage.setItem(DEVICE_KEY, used); warnDevice(); }
            ctx = new AudioContext();
            await ctx.audioWorklet.addModule('/collab-tap.mjs');
            node = new AudioWorkletNode(ctx, 'collab-tap');
            segmenter = new Segmenter({ threshold: Number(el('threshold').value) });
            node.port.onmessage = ({ data }) => {
                for (const ev of segmenter.push(downsample(data, ctx.sampleRate))) {
                    if (ev.type === 'start') { state('話しています'); void say(true); }
                    else { state('聞いています'); void say(false); if (ev.type === 'end') send(ev.pcm); }
                }
                el('level').style.width = `${Math.min(100, segmenter.level / .08 * 100)}%`;
            };
            ctx.createMediaStreamSource(stream).connect(node);
            state('聞いています'); el('stop').disabled = false;
        } catch (e) { state(`開始できません：${e.message}`); stop(); }
    }
    function stop() {
        node?.disconnect(); node = null; ctx?.close().catch(() => { }); ctx = null;
        stream?.getTracks().forEach(t => t.stop()); stream = null; segmenter = null;
        void say(false);
        el('start').disabled = false; el('stop').disabled = true;
        if (!/^開始できません/.test(el('state').textContent)) state('停止中');
    }
    try { const t = localStorage.getItem(THRESHOLD_KEY); if (t) el('threshold').value = t; } catch { }
    markThreshold();
    el('threshold').oninput = () => { markThreshold(); try { localStorage.setItem(THRESHOLD_KEY, el('threshold').value); } catch { } if (segmenter) segmenter.threshold = Number(el('threshold').value); };
    el('device').onchange = () => { warnDevice(); try { localStorage.setItem(DEVICE_KEY, el('device').value); } catch { } };
    el('start').onclick = () => void start();
    el('stop').onclick = stop;
    window.addEventListener('pagehide', () => { void say(false); });
    listDevices().catch(() => { });
}

// Never fall back to BlackHole 2ch for the partner: it carries Noa's own voice to Discord (docs/COLLAB.md).
capture({ id: 'collab', segment: '/api/collab/segment', speaking: '/api/collab/speaking', accepted: '返事します',
    pick: devices => devices.find(d => /blackhole\s*16/i.test(d.label)), warn: label => /blackhole\s*2ch/i.test(label) });
// The person behind Noa: a real mic, never a BlackHole loopback (that would be Noa or the partner).
capture({ id: 'human', segment: '/api/human/segment', speaking: null, accepted: 'ノアの声で話します',
    pick: devices => devices.find(d => !/blackhole|virtual|仮想/i.test(d.label)), warn: label => /blackhole/i.test(label) });
