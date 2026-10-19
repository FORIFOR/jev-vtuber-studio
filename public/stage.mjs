import { roleLabel, hostMouthLevel } from './speech-role.mjs';
import { PcmPlayer } from './pcm-player.mjs';
import { NoaBlocks } from './noa-blocks.mjs';
import { COLS, ROWS } from './blocks-core.mjs';
import { AvatarController, REACTIONS } from './avatar-rig.mjs';
import { LayerAvatar, setBlushFloor } from './layer-avatar.mjs';
import { NoaAvatarV4 } from './noa-avatar-v4.mjs';
import { SpeechVisemeClock } from './speech-visemes.mjs';
import { EffectDirector, speechEffect, gameEffect } from './effect-director.mjs';
import { EffectsLayer } from './effects-layer.mjs';
import { voiceLead, INTENSITY_GAIN } from './voice-acting.mjs';
import { DEFAULT_OUTFIT_ID, isOutfitId } from './avatar-outfits.mjs';
import { DEFAULT_AVATAR_MODE, isAvatarMode } from './avatar-modes.mjs';
import { participationView } from './participation-view.mjs';
import { SponsorView, AdRotation, sponsorLayerVisible } from './sponsor-view.mjs';
import { DecisionView } from './decision-view.mjs';
import { ActionLogView } from './action-log-view.mjs';
import { resolveStageTheme, roomApplies, roomTopic, chatBadges, speechReactionAsset, GameReactionTracker, ReactionGate, reactionBox, drinkCanApplies, isDrinkCue, drinkReactionAsset } from './stage-theme.mjs';
// Options come from the fragment (#token=…&layout=…) and also from the query (?fx=off, ?renderer=v3); get() returns the
// first match, so a fragment value wins over the same key in the query.
const $ = id => document.getElementById(id), params = new URLSearchParams([...new URLSearchParams(location.hash.slice(1)), ...[...new URLSearchParams(location.search)].filter(([k]) => k !== 'token')]); // the token stays fragment-only (never sent to the server)
const token = params.get('token') || sessionStorage.getItem('jvs-view') || '';
if (token)
    sessionStorage.setItem('jvs-view', token);
const preview = params.has('preview');
document.body.classList.toggle('preview', preview);
const vertical = params.get('layout') === 'vertical';
document.body.classList.toggle('vertical', vertical);
// 'overlay': a transparent layer over a captured game window (Vampire Survivors): Noa, subtitles and comments only.
const overlay = params.get('layout') === 'overlay';
document.body.classList.toggle('overlay', overlay);
// 'game': the live screen for a game captured outside the browser (Vampire Survivors). OBS puts the game window over
// #vs-frame (1120x630 at 48,120 of the 1920x1080 canvas); Noa, subtitles and comments stay outside that box.
const gameFrame = params.get('layout') === 'game';
document.body.classList.toggle('game-frame', gameFrame);
if (gameFrame) { $('vs-frame').hidden = false; $('ai-playing').hidden = false; } // the player is an AI (Jev): always disclosed on screen
// Noa's commands shown by their own OBS source beside the chat (OBS_ACTIONS_SOURCE): no second copy on the stage.
if (params.get('actions') === 'external') document.body.classList.add('actions-external');
// An explicit per-view renderer stays pinned; ordinary preview/OBS URLs follow the Studio.
const urlAvatarMode = ['vrm', 'noa', 'builtin', 'png', 'external'].includes(params.get('avatar'))
    ? params.get('avatar') : params.get('renderer') === 'v3' ? 'noa' : null;
let avatarMode = 'builtin', requestedAvatarMode = urlAvatarMode || DEFAULT_AVATAR_MODE;
const canvas = $('canvas');
canvas.dataset.avatarModeSource = urlAvatarMode ? 'url' : 'shared';
canvas.dataset.avatarMode = avatarMode;
canvas.dataset.avatarRequestedMode = requestedAvatarMode;
const sponsorView = new SponsorView($('sponsor-card'), { token: () => token, onState: (state, revision) => {
    canvas.dataset.sponsorRevision = String(revision); canvas.dataset.sponsorState = state;
    canvas.classList.toggle('sponsor-enabled', !$('sponsor-card').hidden);
    $('room-pr-label').textContent = $('sponsor-card').querySelector('[data-sponsor-label]')?.textContent || ''; // the room frame's disclosure
} });
const sponsorAllowed = sponsorLayerVisible(params.get('layer'));
const adRotation = new AdRotation(sponsorView); adRotation.setAllowed(sponsorAllowed);
let adsInitial = true;
const decisionAllowed = gameFrame && !vertical && !overlay && sponsorAllowed;
const decisionView = new DecisionView($('decision-hud'));
const actionLog = new ActionLogView($('action-log'));
let decisionRunnerBlocked = false;
let sponsorInitial = true;
function fit() { canvas.style.transform = `scale(${Math.min(innerWidth / (vertical ? 1080 : 1920), innerHeight / (vertical ? 1920 : 1080))})`; }
addEventListener('resize', fit);
fit();
let profile = 'talk', hostName = 'ノア', speakingRole = 'host';
// A person speaking as Noa (state.control.voice 'human', src/control.mjs): her mouth follows their mic level (human_level).
let humanVoice = false, humanLevel = 0, humanLevelAt = 0;
// Phase 4 (docs/CONTROL.md): the voice passes one gain per utterance so a handoff fades it out (120 ms) instead of a cut;
// `fading` settles when that fade is done (the stage then reports silence for the handoff latency).
let outGain = null, fading = null;
// Avatar Controller (Phase 6): in manual mode the operator's face (state.control.face) holds over every automatic reaction.
let manualFace = null;
const HANDOFF_FADE_MS = 120;
let audienceState = {};
function renderParticipation() {
    if (roomOn) renderRoom();
    const p = participationView(audienceState);
    $('audience-invite').hidden = !p.visible;
    $('show-context').hidden = !p.visible;
    $('show-context').textContent = p.context;
    $('invite-welcome').textContent = p.welcome;
    $('invite-detail').textContent = p.detail;
    $('invite-question').hidden = !p.question;
    $('invite-question').textContent = p.question ? `今のお題：${p.question}` : '';
}
setInterval(renderParticipation, 1000); // also expires an invitation if the event stream stalls
// ---- STAGE_THEME=room (stage-theme.mjs, stage.css 'room'): the Studio's setting arrives with the state; #theme= pins a view.
const urlTheme = params.get('theme'), roomGate = new ReactionGate(), roomGame = new GameReactionTracker();
let stateTheme = null, stateGameLayout = null, roomOn = false, inBrowserGame = false, reactionTimer = null;
// ROOM_GAME_LAYOUT=front|full: Noa in front of the game / the game full screen (OBS puts this page above the capture;
// #gamelayout= pins a view).
const urlGameLayout = params.get('gamelayout');
function applyTheme() {
    const theme = resolveStageTheme(urlTheme, stateTheme);
    const on = roomApplies(theme, { vertical, overlay, layer: params.get('layer'), blocks: canvas.classList.contains('blocks-mode'), inBrowserGame });
    const gameLayout = on && gameFrame && !document.body.classList.contains('lobby');
    const chosen = gameLayout ? (urlGameLayout || stateGameLayout) : null, front = chosen === 'front', full = chosen === 'full', framed = chosen === 'frame', wide = chosen === 'wide';
    const layoutChanged = on && (document.body.classList.contains('room-game') !== gameLayout || document.body.classList.contains('room-front') !== front || document.body.classList.contains('room-full') !== full || document.body.classList.contains('room-frame') !== framed || document.body.classList.contains('room-wide') !== wide);
    document.body.classList.toggle('theme-room', on);
    document.body.classList.toggle('room-game', gameLayout);
    document.body.classList.toggle('room-front', front);
    document.body.classList.toggle('room-full', full);
    document.body.classList.toggle('room-frame', framed);
    document.body.classList.toggle('room-wide', wide);
    document.body.classList.toggle('room-talk', on && !gameLayout);
    // The comment panel is drawn only where OBS places the chat source on it (obs.mjs adds chat=1).
    document.body.classList.toggle('room-chat', on && params.get('chat') === '1');
    canvas.dataset.theme = on ? 'room' : 'classic';
    if (on === roomOn && !layoutChanged) { if (on) renderRoom(); return; }
    roomOn = on;
    if (on) { renderRoom(true); fitRoomCaption(); fitRoomPicked(); }
    else { // back to classic: drop every inline size the room fitting set
        for (const id of ['caption', 'caption-en', 'picked-text', 'room-topic-text']) { $(id).style.fontSize = ''; $(id).style.webkitLineClamp = ''; }
        clearTimeout(reactionTimer); $('room-reaction').hidden = true; roomGate.clear();
    }
}
/** Shrink a box's text until it fits (whole text, never cut mid-line); at the floor, clamp to the lines that fit. */
function fitText(box, items, max, min) {
    for (let size = max; size >= min; size--) {
        for (const [el, ratio] of items) { el.style.fontSize = `${Math.round(size * ratio)}px`; el.style.webkitLineClamp = ''; }
        if (box.scrollHeight <= box.clientHeight + 1 && box.scrollWidth <= box.clientWidth + 1) return size;
    }
    const [el] = items[0], line = parseFloat(getComputedStyle(el).lineHeight) || min * 1.35;
    el.style.webkitLineClamp = String(Math.max(1, Math.floor(box.clientHeight / line)));
    return min;
}
function fitRoomCaption() {
    if (!roomOn) return;
    const game = document.body.classList.contains('room-game'), bubble = ['room-full', 'room-frame', 'room-wide'].some(c => document.body.classList.contains(c));
    // full and frame layouts: the speech bubble beside Noa reads larger (two lines of about 34-38 px); wide: its strip under the game.
    fitText($('caption-box'), [[$('caption'), 1], [$('caption-en'), .64]], bubble ? 40 : game ? 29 : 34, bubble ? 22 : game ? 16 : 18);
}
function fitRoomPicked() {
    if (!roomOn) return;
    const game = document.body.classList.contains('room-game');
    fitText($('picked'), [[$('picked-text'), 1]], game ? 22 : 23, game ? 14 : 16);
}
// ROOM_GAME_LAYOUT=frame: the LIVE clock (this PC's local time), the game's title and the banner's texts (Studio settings).
function renderFrame() {
    const now = new Date(), two = n => String(n).padStart(2, '0');
    $('frame-time').textContent = `${two(now.getHours())}:${two(now.getMinutes())}`;
    $('frame-date').textContent = `${two(now.getMonth() + 1)}/${two(now.getDate())} ${now.toLocaleDateString('en-US', { weekday: 'short' })}`;
    $('frame-title').textContent = audienceState.gameShow?.title || '';
    const b = audienceState.banner || {};
    for (const k of ['hashtag', 'social', 'tagline']) { $(`frame-${k}`).textContent = typeof b[k] === 'string' ? b[k] : ''; $(`frame-${k}`).hidden = !b[k]; }
    // The catchphrase breaks after its first comma (みんなと作る、/特別な時間), as the reference does.
    if (b.tagline) $('frame-tagline').textContent = b.tagline.replace(/([、,])\s*/, '$1\n');
}
setInterval(() => { if (document.body.classList.contains('room-frame')) renderFrame(); }, 10000);
function renderRoom(refit = false) {
    if (document.body.classList.contains('room-frame')) renderFrame();
    const game = document.body.classList.contains('room-game'), topic = roomTopic(audienceState, { game });
    $('room-topic-label').textContent = topic.label;
    if (refit || $('room-topic-text').textContent !== topic.text) { $('room-topic-text').textContent = topic.text; fitText($('room-topic-text'), [[$('room-topic-text'), 1]], game ? 28 : 30, 18); }
    const badges = chatBadges(audienceState.streamTarget || '');
    $('room-yt').hidden = !badges.youtube; $('room-tw').hidden = !badges.twitch; $('room-cheer-sub').hidden = !badges.twitch;
    $('room-idle').textContent = participationView(audienceState).welcome;
}
// ---- NOA BEER (DRINK_MODE): the Studio's setting arrives with the state (drinkMode: true only when on).
let drinkOn = false, sipTimer = null;
function applyDrink() {
    const on = drinkCanApplies(drinkOn, { vertical, overlay, layer: params.get('layer'), blocks: canvas.classList.contains('blocks-mode') });
    $('drink-can').hidden = !on;
    setBlushFloor(on ? .85 : .45);
    if (!on) { clearTimeout(sipTimer); $('drink-can').classList.remove('sip'); }
}
/** A sip line starts: the can lifts and tilts, a small pop says what she said first (ぷはー / ヒック). */
function drinkSip(d) {
    const can = $('drink-can');
    if (can.hidden || !fxOn) return;
    $('drink-pop').textContent = /ぷは/.test(d.text || '') ? 'ぷはーっ！' : /ヒック/.test(d.text || '') ? 'ヒック！' : 'ごくっ';
    can.classList.remove('sip'); void can.offsetWidth; can.classList.add('sip');
    clearTimeout(sipTimer); sipTimer = setTimeout(() => can.classList.remove('sip'), 2600);
}
/** A reaction sticker beside Noa's head, if the gate allows one now. */
function roomReact(asset, key) {
    if (!roomOn || !fxOn || !asset) return;
    const el = $('avatar'), box = reactionBox(asset, { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }, avatarMode);
    if (!box) return;
    const shown = roomGate.offer(asset, key); if (!shown) return;
    const old = $('room-reaction'), img = old.cloneNode(false); // a fresh node restarts the animation
    img.src = `/models/room/react${asset}.png`; img.dataset.reaction = asset; img.hidden = false;
    Object.assign(img.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.size}px`, height: `${box.size}px` });
    img.style.setProperty('--react-ms', `${shown.ms}ms`);
    old.replaceWith(img);
    clearTimeout(reactionTimer); reactionTimer = setTimeout(() => { $('room-reaction').hidden = true; }, shown.ms);
}
let mode = 'demo', wantsAudio = false, streamConnected = false, lease = null, current = null, audioContext = null, source = null, analyser = null, utterance = null, demoTimer = null, desiredMouth = 0, fakeMouth = false, claimBusy = false, renderEpoch = 0;
function showRole(role = 'host') {
    speakingRole = role; canvas.dataset.speaker = role;
    for (const el of document.querySelectorAll('.caption-name span')) el.textContent = roleLabel(role, hostName);
}
// Avatar: one controller for idle life, reactions and lip sync. The same frame drives
// the built-in SVG and, through the server, a Live2D model in VTube Studio.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const avatar = new AvatarController({ reducedMotion, now: performance.now() });
const rig = Object.fromEntries(['hair-back', 'hair-side', 'bangs', 'rig', 'body', 'head', 'face', 'eye-l', 'eye-r', 'iris-l', 'iris-r', 'smile-l', 'smile-r', 'brow-l', 'brow-r', 'cheek-l', 'cheek-r', 'mouth-closed', 'mouth-open', 'tongue'].map(id => [id, $(id)]));
let onAir = false, reactedId = null, cueTimers = [], mouthScale = 1, settleTimer = null, cameraTimer = null, pickedTimer = null, pickedText = '', forwardAvatar = true, lastAvatarPost = 0, avatarPostBusy = false;
const f = n => Math.round(n * 100) / 100, hair = { x: 0, vx: 0, z: 0, vz: 0 };
// Noa's effects (?fx=off for a clean comparison). Decisions in effect-director.mjs; drawing in effects-layer.mjs.
const fxOn = params.get('fx') !== 'off', fxDirector = new EffectDirector();
const fxLayer = new EffectsLayer($('fx-layer'), { avatar: () => $('avatar'), reducedMotion,
    board: () => { const p = $('blocks-panel'), f = p?.querySelector('.blocks-field'); return p && !p.hidden && f ? { x: p.offsetLeft + f.offsetLeft, y: p.offsetTop + f.offsetTop, w: f.offsetWidth, h: f.offsetHeight } : null; } });
function playEffect(e) {
    if (!fxOn || !e) return;
    fxLayer.show(e);
    // A sound only from the one audio owner, soft enough never to cover a line.
    if (e.sfx === 'chime' && lease && wantsAudio && audioContext?.state === 'running') {
        const t = audioContext.currentTime;
        for (const [i, f] of [880, 1320].entries()) {
            const o = audioContext.createOscillator(), g = audioContext.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(f, t + i * .12);
            g.gain.setValueAtTime(0, t + i * .12); g.gain.linearRampToValueAtTime(.02, t + i * .12 + .01); g.gain.exponentialRampToValueAtTime(.0001, t + i * .12 + .5);
            o.connect(g); g.connect(audioContext.destination); o.start(t + i * .12); o.stop(t + i * .12 + .55); o.onended = () => { o.disconnect(); g.disconnect(); };
        }
    }
}
let layerAvatar = null, vrmAvatar = null, stageDisposed = false;
let layerLoading = null, vrmLoading = null, avatarEpoch = 0, vrmLoadEpoch = 0, fallbackEpoch = -1, avatarModeRevision = -1;
let avatarSelectionStarted = false;
let vrmCanvas = $('noa-vrm'), retiredVrmCanvas = false;
let outfitId = DEFAULT_OUTFIT_ID;
function applyWardrobe(snapshot) {
    if (!isOutfitId(snapshot?.outfitId) || stageDisposed) return;
    outfitId = snapshot.outfitId;
    try {
        vrmAvatar?.setOutfit(outfitId);
        if (avatarMode === 'vrm' && vrmAvatar?.ready) canvas.dataset.outfit = outfitId;
    } catch (error) { invalidateVrm(); void fallbackVrm(error); }
}
/** Small synthesized sound effects for comment reactions (no audio files): a few soft tones per reaction, quiet under
 * the voice. Played only by the page that owns the voice lease (OBS on air), never by a muted preview. ?se=off disables. */
const SE_NOTES = { happy: [[880, 0], [1175, .09]], surprised: [[660, 0, 1320]], embarrassed: [[1568, 0], [1976, .07], [2349, .14]],
    troubled: [[659, 0], [523, .12]], thinking: [[784, 0]], listen: [[1047, 0]], excited: [[988, 0], [1319, .08], [1760, .16]] };
function commentSE(reaction) {
    if (params.get('se') === 'off' || !audioContext || !lease || !wantsAudio) return;
    const notes = SE_NOTES[reaction] || SE_NOTES.listen, t0 = audioContext.currentTime + .01;
    for (const [freq, at, sweepTo] of notes) {
        const osc = audioContext.createOscillator(), gain = audioContext.createGain(), t = t0 + at;
        osc.type = 'sine'; osc.frequency.setValueAtTime(freq, t);
        if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, t + .12);
        gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(.12, t + .012); gain.gain.exponentialRampToValueAtTime(.0005, t + .28);
        osc.connect(gain).connect(audioContext.destination); osc.start(t); osc.stop(t + .3);
    }
}
/** Run number and the real personal best of an external game's run (the game shows its own clock and level). Any game
 * show from games/<id> reports { phase, run, personalBest } under its statusKey (docs/GAMES.md). */
let gameShowKey = null;
function gameHud(v) {
    decisionView.setState({ running: decisionAllowed && !decisionRunnerBlocked && audienceState.running === true, phase: v?.phase ?? '', runId: v?.roundId ?? null, epoch: audienceState.epoch });
    actionLog.setState({ running: decisionAllowed && !decisionRunnerBlocked && audienceState.running === true, phase: v?.phase ?? '', runId: v?.roundId ?? null, epoch: audienceState.epoch });
    // Opening talk before the game, and the goodbye after its first line (operator 2026-10-11): Noa centre stage, no game
    // frame (the game layout returns when the game is announced; the goodbye ends the show).
    // A stopped show is not play either (2026-10-19: the game layout and a stopped game's last frame stayed up).
    const talk = v?.phase === 'lobby' || audienceState.farewell?.step >= 1 || audienceState.running === false;
    document.body.classList.toggle('lobby', talk);
    applyTheme();
    for (const r of roomGame.update(v)) roomReact(r.asset, r.key);
    // Who plays is a fact of the game (docs/GAMES.md player): never 'AIがプレイ中' for a game a person plays.
    $('ai-playing-label').textContent = v?.player === 'operator' ? 'AIが実況中' : v?.phase === 'playing' ? 'AIがゲームを完全自立で実況プレイ中' : 'AIゲーム実況';
    const el = $('vs-hud'); if (!el) return;
    el.hidden = !v || !v.run || talk;
    if (el.hidden) return;
    const clock = s => { const t = Math.floor(s); return t >= 60 ? `${Math.floor(t / 60)}分${t % 60 ? `${t % 60}秒` : ''}` : `${t}秒`; };
    $('vs-run').textContent = `${v.run}回目`;
    // Operator 2026-10-10: a best that resets with the character / a restart read as an unknown record — not shown.
    $('vs-best').hidden = true;
    $('vs-best').textContent = v.personalBest === null || v.personalBest === undefined ? '自己ベスト：まだなし' : `自己ベスト：${clock(v.personalBest)}`;
}
// Optional painted room (docs/ART_BRIEF.md): background.png replaces the drawn backdrop shapes; desk.png (transparent,
// full canvas) is the foreground in front of Noa and replaces the drawn desk, keyboard and mug.
if (!overlay) { const img = new Image(); img.onload = () => { canvas.style.setProperty('--room-art', `url(${img.src})`); document.body.classList.add('room-art'); }; img.src = '/models/room/background.png'; }
if (!overlay) { const img = $('desk-art'); img.onload = () => { img.hidden = false; document.body.classList.add('desk-art'); }; img.onerror = () => { img.hidden = true; }; img.src = '/models/room/desk.png'; }
function showAvatar(nextMode, state) {
    const entering = avatarMode !== nextMode;
    avatarMode = nextMode;
    for (const [name, enabled] of [['vrm', nextMode === 'vrm'], ['layers', nextMode === 'noa'], ['png', nextMode === 'png'], ['external', nextMode === 'external']])
        document.body.classList.toggle(name, enabled);
    $('noa-layers').hidden = nextMode !== 'noa';
    vrmCanvas.hidden = nextMode !== 'vrm';
    $('png-avatar').hidden = nextMode !== 'png';
    canvas.dataset.avatarMode = nextMode;
    canvas.dataset.avatarState = state;
    if (nextMode === 'vrm') {
        canvas.dataset.outfit = outfitId;
        if (entering) vrmAvatar.resume(avatar.reaction);
    } else delete canvas.dataset.outfit;
    if (nextMode === 'noa' && entering) layerAvatar.resume?.();
    // Switching away is also the low-memory escape hatch: release decoded
    // textures, geometry and the WebGL context only after replacement succeeds.
    if (nextMode !== 'vrm') releaseVrm();
}
function loadLayerAvatar() {
    if (layerLoading) return layerLoading;
    if (layerAvatar?.ready) return Promise.resolve(layerAvatar);
    // v4 (head-turn warp, eyelids, lip shapes, hair springs, room light) by default; ?renderer=v3 keeps the lighter one.
    const Avatar = params.get('renderer') === 'v3' ? LayerAvatar : NoaAvatarV4;
    const candidate = new Avatar($('noa-layers'), { grade: true });
    layerAvatar = candidate;
    const pending = candidate.load().then(() => {
        if (stageDisposed || layerAvatar !== candidate) throw new Error('Noa 2D load was retired');
        return candidate;
    }).catch(error => {
        if (layerAvatar === candidate) layerAvatar = null;
        throw error;
    }).finally(() => { if (layerLoading === pending) layerLoading = null; });
    layerLoading = pending;
    return pending;
}
function invalidateVrm(candidate = vrmAvatar) {
    if (!candidate || vrmAvatar !== candidate) return;
    vrmAvatar = null;
    vrmLoading = null;
    // Disposal deliberately loses the context. Detach our listener and retire that canvas first.
    vrmCanvas.removeEventListener('webglcontextlost', onVrmContextLost);
    retiredVrmCanvas = true;
    if (!stageDisposed && avatarMode === 'vrm')
        showAvatar(layerAvatar?.ready && !layerLoading ? 'noa' : 'builtin', canvas.dataset.avatarState === 'loading' ? 'loading' : 'fallback');
    candidate.dispose();
}
function releaseVrm() {
    // Invalidate even a pending module import, before it allocates WebGL/model
    // resources. Late completion from that load cannot replace a later attempt.
    vrmLoadEpoch++;
    vrmLoading = null;
    invalidateVrm();
}
async function fallbackVrm(error, epoch = avatarEpoch) {
    if (stageDisposed || epoch !== avatarEpoch || requestedAvatarMode !== 'vrm' || fallbackEpoch === epoch) return;
    fallbackEpoch = epoch;
    console.error('Noa VRM unavailable; using the existing 2D avatar.', error);
    if (avatarMode === 'vrm') showAvatar(layerAvatar?.ready && !layerLoading ? 'noa' : 'builtin', 'loading');
    try {
        await loadLayerAvatar();
        if (!stageDisposed && epoch === avatarEpoch) showAvatar('noa', 'fallback');
    } catch {
        if (!stageDisposed && epoch === avatarEpoch) showAvatar('builtin', 'fallback');
    }
}
function loadVrmAvatar() {
    if (vrmLoading) return vrmLoading;
    if (vrmAvatar?.ready && !vrmAvatar.error) return Promise.resolve(vrmAvatar);
    const loadEpoch = ++vrmLoadEpoch;
    let candidate;
    const pending = (async () => {
        const { NoaVrmAvatar } = await import('./noa-vrm-avatar.mjs');
        if (stageDisposed || loadEpoch !== vrmLoadEpoch) throw new Error('Noa 3D load was retired');
        if (retiredVrmCanvas) {
            const replacement = vrmCanvas.cloneNode(false);
            vrmCanvas.replaceWith(replacement);
            vrmCanvas = replacement;
            retiredVrmCanvas = false;
            vrmCanvas.addEventListener('webglcontextlost', onVrmContextLost);
        }
        candidate = new NoaVrmAvatar($('noa-vrm'), { reducedMotion });
        vrmAvatar = candidate;
        candidate.setOutfit(outfitId);
        await candidate.load();
        if (stageDisposed || loadEpoch !== vrmLoadEpoch || vrmAvatar !== candidate || candidate.disposed) throw new Error('Noa 3D load was retired');
        candidate.setOutfit(outfitId);
        return candidate;
    })().catch(error => {
        if (candidate) invalidateVrm(candidate);
        throw error;
    }).finally(() => { if (vrmLoading === pending) vrmLoading = null; });
    vrmLoading = pending;
    return pending;
}
async function selectAvatarMode(nextMode) {
    if (stageDisposed) return;
    avatarSelectionStarted = true;
    const epoch = ++avatarEpoch;
    requestedAvatarMode = nextMode;
    canvas.dataset.avatarRequestedMode = nextMode;
    // Cancel an unfinished hidden 3D download immediately. A working visible
    // 3D renderer is kept until the requested 2D image has actually loaded.
    if (nextMode !== 'vrm' && !vrmAvatar?.ready) releaseVrm();
    // Leave the current image, audio owner and speech clocks intact while another renderer loads.
    canvas.dataset.avatarState = 'loading';
    try {
        if (nextMode === 'vrm') await loadVrmAvatar();
        else if (nextMode === 'noa') await loadLayerAvatar();
        if (stageDisposed || epoch !== avatarEpoch) return;
        showAvatar(nextMode, nextMode === 'vrm' ? 'ready' : nextMode === 'noa' ? '2d' : nextMode);
    } catch (error) {
        if (stageDisposed || epoch !== avatarEpoch) return;
        if (nextMode === 'vrm') void fallbackVrm(error, epoch);
        else {
            console.error('Noa 2D unavailable; retaining a working avatar.', error);
            showAvatar(avatarMode === 'vrm' && vrmAvatar?.ready && !vrmAvatar.error ? 'vrm' : 'builtin', 'fallback');
        }
    }
}
function applyAvatarMode(snapshot) {
    if (urlAvatarMode || stageDisposed || !isAvatarMode(snapshot?.mode) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.revision < avatarModeRevision) return;
    if (snapshot.revision === avatarModeRevision) return;
    avatarModeRevision = snapshot.revision;
    if (avatarSelectionStarted && requestedAvatarMode === snapshot.mode && (canvas.dataset.avatarState === 'loading' || avatarMode === snapshot.mode)) return;
    void selectAvatarMode(snapshot.mode);
}
function onVrmContextLost(event) {
    if (stageDisposed || event.currentTarget !== vrmCanvas || !vrmAvatar) return;
    event.preventDefault();
    const error = new Error('WebGL context lost');
    invalidateVrm();
    void fallbackVrm(error);
}
vrmCanvas.addEventListener('webglcontextlost', onVrmContextLost);
// Authenticated shared views learn the saved mode before downloading either model.
if (urlAvatarMode || !token) void selectAvatarMode(requestedAvatarMode);
else canvas.dataset.avatarState = 'loading';
addEventListener('pagehide', event => {
    cancel();
    // A cached page resumes its existing RAF on Back/Forward; retain that context.
    decisionView.clear(); actionLog.clear();
    if (!event.persisted) { sponsorView.dispose(); decisionView.dispose(); actionLog.dispose(); stageDisposed = true; avatarEpoch++; releaseVrm(); layerAvatar = null; }
});
// Query/reading-derived shapes follow the WAV playback clock. Engines without
// timing metadata keep amplitude-driven mouths; written kanji never invent vowels.
const rimOn = params.get('rim') !== 'off', lip = new SpeechVisemeClock();
function avatarExtras(now, level) {
    const name = avatar.reaction?.name, speaking = !!current && (current.role || speakingRole) !== 'comment';
    return { now, speaking, role: current?.role || speakingRole, mouthLevel: level,
        reaction: avatar.reaction ? { name, start: avatar.reaction.start, gain: avatar.reaction.gain, weight: avatar.weight(now) } : null,
        vis: lip.sample(audioContext?.currentTime), led: speaking ? .45 + .55 * level : .25 + .12 * Math.sin(now / 700), rim: rimOn,
        sparkle: ['happy', 'excited', 'laugh'].includes(name) ? 1 : .55, lamp: .92 + .05 * Math.sin(now / 900) + .03 * Math.sin(now / 137), motion: reducedMotion ? .25 : 1 };
}
function draw(p, extras = {}) {
    if (avatarMode === 'vrm') {
        try { vrmAvatar?.draw(p, extras); } catch (error) { invalidateVrm(); void fallbackVrm(error); }
        return;
    }
    if (avatarMode === 'noa') { layerAvatar?.draw(p, extras); return; }
    if (avatarMode === 'png') { $('png-avatar').src = p.ParamMouthOpenY > .12 ? '/avatar-talk.png' : '/avatar-idle.png'; return; }
    if (avatarMode !== 'builtin') return;
    const set = (id, value) => rig[id].setAttribute('transform', value);
    set('rig', `translate(${f(p.ParamBodyAngleX * 5)} ${f(-p.ParamBodyAngleY * 3)}) rotate(${f(p.ParamBodyAngleZ * 1.2)} 220 530)`);
    set('body', `translate(0 532) scale(${f(1 + p.ParamBreath * .006)} ${f(1 + p.ParamBreath * .016)}) translate(0 -532)`);
    const hx = p.ParamAngleX * 1.3, hz = p.ParamAngleZ * .9;
    set('head', `translate(${f(hx)} ${f(-p.ParamAngleY * .9 - p.ParamBreath * 2)}) rotate(${f(hz)} 220 320)`);
    // Hair physics stand-in: the hair trails the head on a damped spring, so every turn leaves a little swing.
    hair.vx = (hair.vx + (hx - hair.x) * .09) * .82; hair.x += hair.vx;
    hair.vz = (hair.vz + (hz - hair.z) * .07) * .84; hair.z += hair.vz;
    const lagX = hx - hair.x, lagZ = hz - hair.z;
    set('hair-back', `rotate(${f(-lagZ * 1.6 - lagX * .35)} 220 90)`); set('hair-side', `rotate(${f(-lagZ * 2.2 - lagX * .5)} 220 110)`);
    set('bangs', `translate(${f(-lagX * .45)} 0) rotate(${f(-lagZ * .8)} 220 105)`);
    set('face', `translate(${f(p.ParamAngleX * .35)} ${f(-p.ParamAngleY * .25)})`);
    for (const [side, open, smile] of [['l', p.ParamEyeLOpen, p.ParamEyeLSmile], ['r', p.ParamEyeROpen, p.ParamEyeRSmile]]) {
        set(`eye-${side}`, `translate(0 224) scale(1 ${f(Math.max(.04, open * (1 - .88 * smile * smile)))}) translate(0 -224)`);
        set(`iris-${side}`, `translate(${f(p.ParamEyeBallX * 5)} ${f(-p.ParamEyeBallY * 3)})`);
        rig[`smile-${side}`].setAttribute('opacity', String(f(Math.min(1, Math.max(0, (smile - .6) * 2.5)) * Math.min(1, open))));
    }
    set('brow-l', `translate(0 ${f(-p.ParamBrowLY * 10)}) rotate(${f(-p.ParamBrowLAngle * 12)} 175 201)`);
    set('brow-r', `translate(0 ${f(-p.ParamBrowRY * 10)}) rotate(${f(p.ParamBrowRAngle * 12)} 265 201)`);
    for (const id of ['cheek-l', 'cheek-r']) { rig[id].setAttribute('opacity', String(f(.35 + p.ParamCheek * .6))); rig[id].setAttribute('rx', String(f(14 + p.ParamCheek * 4))); }
    const open = p.ParamMouthOpenY, form = p.ParamMouthForm, w = 16 + Math.max(0, form) * 4;
    rig['mouth-closed'].setAttribute('d', `M${f(222 - w)} 280 Q222 ${f(280 + form * 12)} ${f(222 + w)} 280`);
    rig['mouth-closed'].style.opacity = String(f(Math.max(0, 1 - open * 1.6)));
    rig['mouth-open'].setAttribute('ry', String(f(open * 13)));
    rig['mouth-open'].setAttribute('rx', String(f(10 + Math.max(0, form) * 4 + open * 3)));
    rig.tongue.setAttribute('ry', String(f(open * 3.5)));
}
function levelFromAudio() {
    // Subtitle-only demo has no audio to analyse; keep the mouth visibly moving.
    if (fakeMouth) return .2 + .35 * Math.abs(Math.sin(performance.now() / 95));
    if (!analyser) return desiredMouth;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const x of data) sum += ((x - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / data.length) * 7);
}
// Where Noa looks when nothing else directs her: the board while a round is played, the result when it ends.
const BOARD_GAZE = { x: -.85, y: -.25 };
function attention(wall) {
    if (!blocks) return null;
    if (blocks.phase === 'playing' && blocks.endsAt) return { ...BOARD_GAZE, lean: 1 };
    if (blocks.phase === 'results' && wall - (blocks.resultsSeenAt || wall) < 1800) return { ...BOARD_GAZE, y: -.05, lean: .6 };
    return null;
}
function tick(now) {
    avatar.attend(attention(Date.now()));
    const human = humanVoice && Date.now() - humanLevelAt < 400 ? humanLevel : 0;
    const level = (current ? hostMouthLevel(current.role || speakingRole, levelFromAudio()) : human) * mouthScale;
    avatar.mouth(level);
    const params = avatar.update(now);
    draw(params, ['noa', 'vrm'].includes(avatarMode) ? avatarExtras(now, level) : undefined);
    // Only the audio owner drives VTube Studio; back off when the server has no VTS link.
    const wall = Date.now();
    if (lease && !avatarPostBusy && wall - lastAvatarPost > (forwardAvatar ? 50 : 1000)) {
        lastAvatarPost = wall; avatarPostBusy = true;
        api('/api/renderer/avatar', { lease, params }).then(r => { forwardAvatar = !!r.forward; }, () => { forwardAvatar = false; }).finally(() => { avatarPostBusy = false; });
    }
    requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
/** Reflex first, then the voice: returns how long to hold the audio back. */
const gainOf = intensity => Object.hasOwn(INTENSITY_GAIN, String(intensity)) ? INTENSITY_GAIN[intensity] : 1;
function act(id, name, role, intensity) {
    if (manualFace) return 0; // the operator leads the face
    if (id && reactedId === id) return 0;
    reactedId = id;
    clearTimeout(settleTimer);
    const reaction = role === 'comment' ? 'listen' : (Object.hasOwn(REACTIONS, name) ? name : 'neutral');
    const lead = avatar.react(reaction, performance.now(), gainOf(intensity));
    // v4: a squash-and-stretch bounce and a light pulse that belong to the same reaction.
    if (avatarMode === 'noa' && layerAvatar?.kick) {
        const kick = { surprised: .6, shock: 1, excited: .5, laugh: .25 }[reaction];
        if (kick && !reducedMotion) layerAvatar.kick(kick);
        if (['happy', 'laugh', 'excited', 'embarrassed'].includes(reaction)) layerAvatar.pulseLight('warm', reaction === 'excited' ? 1 : .6);
        if (['surprised', 'shock'].includes(reaction)) layerAvatar.pulseLight('cool', 1);
    }
    clearTimeout(cameraTimer);
    $('avatar').classList.toggle('zoom', REACTIONS[reaction].camera === 'face_zoom' && intensity !== 'low' && !reducedMotion);
    if (REACTIONS[reaction].camera === 'face_zoom') cameraTimer = setTimeout(() => $('avatar').classList.remove('zoom'), lead + 1800);
    return Math.min(400, lead);
}
const clampMs = (v, max) => Math.max(0, Math.min(max, v));
function clearCues() { for (const t of cueTimers) clearTimeout(t); cueTimers = []; mouthScale = 1; }
/** Mid-part acting beats and mouth windows, timed from the moment the WAV starts playing. */
function scheduleCues(s) {
    clearCues();
    if (manualFace) return; // no acting beats over the operator's face (the mouth still follows the voice)
    const gain = gainOf(s.intensity), at = (ms, fn) => cueTimers.push(setTimeout(() => { if (current?.id === s.id) fn(); }, clampMs(ms, 45000)));
    for (const b of (Array.isArray(s.beats) ? s.beats : []).slice(0, 4)) {
        const r = typeof b?.reaction === 'string' && Object.hasOwn(REACTIONS, b.reaction) ? REACTIONS[b.reaction] : null;
        if (!r || r.big || r.local || !Number.isFinite(b.atMs)) continue;
        at(b.atMs, () => avatar.react(b.reaction, performance.now(), gain));
    }
    for (const w of (Array.isArray(s.mouth) ? s.mouth : []).slice(0, 2)) {
        if (!Number.isFinite(w?.startMs) || !Number.isFinite(w.endMs) || !Number.isFinite(w.scale)) continue;
        const scale = Math.max(0, Math.min(1, w.scale));
        at(w.startMs, () => { mouthScale = scale; });
        at(w.endMs, () => { mouthScale = 1; });
    }
}
function settle(role, delay = 0) {
    clearTimeout(settleTimer);
    if (manualFace) return;
    // A narrator's read keeps the avatar looking at the comment until the answer begins.
    settleTimer = setTimeout(() => avatar.settle(performance.now()), role === 'comment' ? Math.max(delay, 5000) : delay);
}
function showPicked(text) {
    clearTimeout(pickedTimer);
    if (!text || params.get('simulcast') === '1') return;
    pickedText = text; $('picked-text').textContent = text; $('picked').classList.add('show');
    fitRoomPicked();
}
function hidePicked(delay) { clearTimeout(pickedTimer); pickedTimer = setTimeout(() => { $('picked').classList.remove('show'); pickedText = ''; }, delay); }

const client = crypto.randomUUID(), played = new Set();
async function api(path, data) { const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); if (!response.ok)
    throw new Error('Stage request failed'); return response.json(); }
if (urlAvatarMode === 'png') $('png-avatar').src = '/avatar-idle.png';
$('png-avatar').onerror = () => { if (avatarMode === 'png') showAvatar('builtin', 'fallback'); };
// Subtitles belong to speech: shown when a line starts, faded CAPTION_LINGER_MS after it ends (status messages stay).
const CAPTION_LINGER_MS = 2500;
let captionTimer = null;
function fadeCaption(delay = CAPTION_LINGER_MS) { clearTimeout(captionTimer); captionTimer = setTimeout(() => $('caption-box').classList.add('faded'), delay); }
// English subtitle (CAPTION_EN): only for the line on screen; it may arrive after the line itself ('speech_en').
let captionId = null;
function setCaptionEn(en) { $('caption-en').textContent = en || ''; $('caption-en').hidden = !en; $('caption-box').classList.toggle('has-en', !!en); fitRoomCaption(); }
function setCaption(text, sources = [], en = '') { clearTimeout(captionTimer); $('caption-box').classList.remove('faded'); $('caption').textContent = text; setCaptionEn(text ? en : ''); $('sources').replaceChildren(...sources.map((item, i) => { const a = document.createElement('a'); try {
    const u = new URL(item.url);
    if (u.protocol !== 'https:')
        return document.createTextNode('');
    a.href = u.href;
    a.textContent = `参考 ${i + 1} · ${u.hostname}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
}
catch { } return a; })); fitRoomCaption(); }
let player = null, streamReader = null;
function cancel() { renderEpoch++; lip.reset(); vrmAvatar?.stop(avatar.reaction); if (player) { player.cancel(); player = null; } if (streamReader) { streamReader.cancel().catch(() => { }); streamReader = null; } if (source) {
    source.onended = null;
    try {
        source.stop();
    }
    catch { }
    source.disconnect();
    source = null;
} if (utterance) {
    utterance.onend = null;
    utterance.onerror = null;
    speechSynthesis.cancel();
    utterance = null;
} clearCues(); clearTimeout(demoTimer); demoTimer = null; fakeMouth = false; const role = current?.role; analyser = null; if (outGain) { try { outGain.disconnect(); } catch { } outGain = null; } desiredMouth = 0; current = null; if (role) settle(role); }
/** A handoff (cancel reason voice_handoff): the voice fades out over 120 ms, then its nodes stop; everything else of the
 * utterance is cleared at once like any cancel, so the next speaker is never blocked. */
function fadeCancel() {
    const g = outGain, src = source, pl = player;
    if (!g || !audioContext) { cancel(); fading = null; return; }
    if (src) src.onended = null;
    outGain = null; source = null; player = null; // detached: cancel() must not cut them
    const t = audioContext.currentTime;
    g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + HANDOFF_FADE_MS / 1000);
    cancel();
    fading = new Promise(resolve => setTimeout(() => {
        try { src?.stop(); } catch { } try { src?.disconnect(); } catch { } pl?.cancel(); try { g.disconnect(); } catch { }
        resolve();
    }, HANDOFF_FADE_MS + 10));
}
async function ack(id, event) { if (!lease)
    return false; try {
    return (await api('/api/renderer/ack', { lease, id, event })).ok;
}
catch {
    return false;
} }
async function finish(id) { if (current?.id !== id)
    return; cancel(); await ack(id, 'ended'); }
async function startSpeech(s) {
    if (!lease || !wantsAudio || played.has(s.id) || current)
        return;
    const epoch = renderEpoch;
    played.add(s.id);
    if (played.size > 1000)
        played.delete(played.values().next().value);
    current = s; lip.prepare(s); showRole(s.role || 'host');
    if (s.comment) showPicked(s.comment);
    const lead = voiceLead(act(s.id, s.reaction, s.role, s.intensity), s.leadMs), reflexDone = new Promise(r => setTimeout(r, lead));
    try {
        if (s.kind === 'wav') {
            const r = await fetch(`${s.audio}?token=${encodeURIComponent(token)}`);
            if (!r.ok)
                throw new Error('Missing audio');
            const bytes = await r.arrayBuffer();
            const buffer = await audioContext.decodeAudioData(bytes);
            if (renderEpoch !== epoch || current?.id !== s.id)
                return;
            if (audioContext.state !== 'running')
                throw new Error('Autoplay blocked');
            source = audioContext.createBufferSource();
            source.buffer = buffer;
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser);
            outGain = audioContext.createGain(); analyser.connect(outGain); outGain.connect(audioContext.destination);
            source.onended = () => { void finish(s.id); };
            await reflexDone;
            if (renderEpoch !== epoch || current?.id !== s.id)
                return;
            if (!await ack(s.id, 'started'))
                throw new Error('Expired utterance');
            if (renderEpoch !== epoch || current?.id !== s.id)
                return;
            const audioStart = audioContext.currentTime;
            source.start(audioStart); lip.start(audioStart);
            scheduleCues(s);
        }
        else if (s.kind === 'stream') {
            // Approved audio arriving as raw PCM chunks: start after a short buffer instead of waiting for the whole file.
            const r = await fetch(`${s.audio}?token=${encodeURIComponent(token)}`);
            if (!r.ok || !r.body)
                throw new Error('Missing audio');
            if (audioContext.state !== 'running')
                throw new Error('Autoplay blocked');
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            outGain = audioContext.createGain(); analyser.connect(outGain); outGain.connect(audioContext.destination);
            const rate = Number(/rate=(\d+)/.exec(r.headers.get('content-type') || '')?.[1]) || 24000;
            let failed = false;
            player = new PcmPlayer({ ctx: audioContext, destination: analyser, rate, prebufferMs: 300,
                beforeStart: async () => { await reflexDone; if (renderEpoch !== epoch || current?.id !== s.id) return false; if (!await ack(s.id, 'started')) { failed = true; return false; } return renderEpoch === epoch && current?.id === s.id; },
                onStart: () => scheduleCues(s),
                onEnd: () => { void finish(s.id); } });
            const mine = player;
            streamReader = r.body.getReader();
            for (;;) {
                const { value, done } = await streamReader.read();
                if (renderEpoch !== epoch || current?.id !== s.id || mine !== player) return;
                if (done) break;
                mine.push(value);
            }
            mine.end();
            if (failed) throw new Error('Expired utterance');
        }
        else {
            const voices = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices().filter(v => v.lang.startsWith('ja') && v.localService) : [];
            if (voices.length) {
                utterance = new SpeechSynthesisUtterance(s.text);
                utterance.voice = voices[0];
                utterance.lang = 'ja-JP';
                utterance.rate = 1.04;
                utterance.onstart = () => { void ack(s.id, 'started'); desiredMouth = .25; };
                utterance.onboundary = () => { desiredMouth = .2 + Math.random() * .5; };
                utterance.onend = () => { void finish(s.id); };
                utterance.onerror = () => { void ack(s.id, 'error'); cancel(); };
                await reflexDone;
                if (renderEpoch !== epoch || current?.id !== s.id)
                    return;
                speechSynthesis.speak(utterance);
                $('audio-status').textContent = '端末音声 / デモ';
            }
            else {
                await reflexDone;
                await ack(s.id, 'started');
                if (renderEpoch !== epoch || current?.id !== s.id)
                    return;
                $('audio-status').textContent = '字幕デモ / 端末の日本語音声なし';
                fakeMouth = true;
                demoTimer = setTimeout(() => { void finish(s.id); }, Math.min(6500, s.durationMs));
            }
        }
    }
    catch {
        if (renderEpoch !== epoch)
            return;
        await ack(s.id, 'error');
        cancel();
        lease = null;
        wantsAudio = false;
        $('audio-button').textContent = '音声を再接続';
        $('audio-status').textContent = '音声出力を確認してください';
    }
}
async function claim() { if (!wantsAudio || !streamConnected || claimBusy)
    return; claimBusy = true; try {
    const result = await api('/api/renderer/claim', { client, rendererKey: params.get('rendererKey') || '' });
    if (result.acquired) {
        lease = result.lease;
        document.querySelector('.audio-controls').classList.add('active');
        $('audio-button').textContent = 'この画面の音声を無効にする';
    }
    else {
        cancel();
        lease = null;
        $('audio-status').textContent = '別の画面が音声を再生中';
        $('audio-button').textContent = '音声待ちを解除';
    }
}
catch {
    cancel();
    lease = null;
}
finally {
    claimBusy = false;
} }
async function enableAudio() {
    if (wantsAudio) {
        wantsAudio = false;
        const old = lease;
        lease = null;
        cancel();
        if (old)
            await api('/api/renderer/release', { lease: old }).catch(() => { });
        document.querySelector('.audio-controls').classList.remove('active');
        $('audio-button').textContent = '音声を有効にする';
        $('audio-status').textContent = 'この画面は消音';
        return;
    }
    try {
        audioContext ??= new AudioContext();
        await audioContext.resume();
        if (audioContext.state !== 'running')
            throw new Error();
        wantsAudio = true;
        await claim();
    }
    catch {
        $('audio-status').textContent = 'クリックして音声を有効にしてください';
    }
}
$('audio-button').onclick = () => { void enableAudio(); };
setInterval(() => { void claim(); }, 2000);
setInterval(() => { if (manualFace) avatar.react(manualFace, performance.now(), 1); }, 2500);
function game(data) {
    if (!data) return;
    $('score').textContent = String(data.score).padStart(2, '0');
    const cells = [];
    for (let y = 0; y < data.size; y++)
        for (let x = 0; x < data.size; x++) {
            const cell = document.createElement('span');
            cell.className = 'cell';
            if (data.blocks.some(b => b.x === x && b.y === y))
                cell.classList.add('block');
            if (data.target.x === x && data.target.y === y) {
                cell.classList.add('target');
                cell.textContent = '✦';
            }
            if (data.player.x === x && data.player.y === y) {
                cell.classList.add('player');
                cell.textContent = '•';
            }
            cells.push(cell);
        }
    $('grid').replaceChildren(...cells);
    const panel = $('game-panel');
    if (panel) panel.classList.toggle('paused', !!data.paused);
}
function effect(name) {
    if (name === 'none' || profile === 'talk')
        return;
    if (lease && wantsAudio && audioContext?.state === 'running' && ['spark', 'surprise'].includes(name)) {
        const t = audioContext.currentTime, osc = audioContext.createOscillator(), gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(name === 'spark' ? 660 : 440, t);
        osc.frequency.exponentialRampToValueAtTime(name === 'spark' ? 880 : 640, t + .18);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(.025, t + .012);
        gain.gain.exponentialRampToValueAtTime(.0001, t + .24);
        osc.connect(gain);
        gain.connect(audioContext.destination);
        osc.start(t);
        osc.stop(t + .25);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    }
    const el = $('effect');
    el.textContent = ({ spark: '✦ やった', surprise: 'おっ！', thought: '…' })[name] || '';
    el.classList.remove('active');
    void el.offsetWidth;
    el.classList.add('active');
    setTimeout(() => { el.classList.remove('active'); el.textContent = ''; }, 1800);
}
const stream = new EventSource(`/events?token=${encodeURIComponent(token)}`);
stream.onopen = () => { sponsorInitial = true; adsInitial = true; avatarModeRevision = -1; streamConnected = true; void claim(); };
stream.onerror = () => { streamConnected = false; audienceState = {}; decisionView.setState({ running: false }); actionLog.setState({ running: false }); renderParticipation(); cancel(); $('audio-status').textContent = '再接続しています'; };
stream.onmessage = event => {
    let m;
    try {
        m = JSON.parse(event.data);
    }
    catch {
        return;
    }
    const d = m.data;
    if (m.type === 'game_runner') {
        decisionRunnerBlocked = !['starting', 'playing'].includes(d?.state);
        if (decisionRunnerBlocked) { decisionView.setState({ running: false }); actionLog.setState({ running: false }); }
    }
    // After a handoff: report silence once the fade (if any) is done; only the audio owner (lease) is counted.
    if (m.type === 'handoff') { const seq = d?.seq, wait = fading || Promise.resolve(); void wait.then(() => { if (lease) api('/api/renderer/handoff', { lease, seq }).catch(() => { }); }); }
    if (m.type === 'human_level') { humanLevel = Math.max(0, Math.min(1, Number(d?.level) || 0)); humanLevelAt = Date.now(); }
    if (m.type === 'game_decision' && decisionAllowed) decisionView.push(d);
    if (m.type === 'game_actions' && decisionAllowed) actionLog.update(d);
    if (m.type === 'sponsor') {
        const authoritative = sponsorInitial; sponsorInitial = false;
        adRotation.receiveSponsor(d, authoritative);
    }
    if (m.type === 'ads') { const authoritative = adsInitial; adsInitial = false; adRotation.receiveAds(d, authoritative); }
    if (m.type === 'wardrobe') applyWardrobe(d);
    if (m.type === 'avatar_mode') applyAvatarMode(d);
    if (m.type === 'state') {
        humanVoice = d.control?.voice === 'human';
        const face = d.control?.avatar === 'manual' && Object.hasOwn(REACTIONS, d.control.face) ? d.control.face : null;
        if (face !== manualFace) { manualFace = face; if (face) avatar.react(face, performance.now(), 1); else avatar.settle(performance.now()); }
        audienceState = d; stateTheme = d.stageTheme ?? null; stateGameLayout = d.roomGameLayout ?? null; inBrowserGame = !!d.game; applyTheme(); renderParticipation();
        drinkOn = d.drinkMode === true; applyDrink();
        mode = d.mode; profile = d.profile || 'playground';
        // Programme, phase and mode are operator information: shown in the Studio, not here.
        canvas.classList.toggle('has-game', !!d.game);
        // Voice credits are a licence condition, so they stay on the viewer screen.
        $('voice-credit').textContent = d.voiceCredit ? `AIによる自動配信 · ${d.voiceCredit}` : 'AIによる自動配信';
        hostName = d.name || 'ノア'; const w = $('blocks-with'); if (w) w.textContent = `with ${hostName}`;
        showRole(d.pending?.role || 'host');
        canvas.classList.toggle('emergency', !!d.panic);
        $('game-panel').hidden = !d.game;
        fxDirector.setEpoch(d.epoch);
        if (d.blocks) blocksHud(d.blocks);
        gameShowKey = d.gameShow?.external ? d.gameShow.statusKey : null;
        gameHud(gameShowKey ? d[gameShowKey] : null);
        if (d.game)
            game(d.game);
        if (d.pending?.started) {
            captionId = d.pending.id;
            setCaption(params.get('simulcast') === '1' && ['comment', 'narrator'].includes(d.pending.role) ? '' : d.pending.text, d.pending.sources, d.pending.en);
        }
        if (!d.running) {
            cancel();
            if (d.panic)
                setCaption('ただいま配信を停止しています。');
        }
    }
    if (m.type === 'game')
        game(d);
    if (gameShowKey && m.type === gameShowKey) {
        audienceState = { ...audienceState, [gameShowKey]: d }; renderParticipation();
        gameHud(d);
    }
    if (m.type === 'youtube' || m.type === 'twitch') {
        audienceState = { ...audienceState, [m.type]: d.state }; renderParticipation();
    }
    if (m.type === 'blocks')
        blocksHud(d);
    if (m.type === 'speech')
        void startSpeech(d);
    if (m.type === 'speech_en' && d.id === captionId && $('caption').textContent)
        setCaptionEn(d.en);
    if (m.type === 'speech_started') {
        onAir = true;
        showRole(d.role || 'host');
        captionId = d.id;
        setCaption(params.get('simulcast') === '1' && ['comment', 'narrator'].includes(d.role) ? '' : d.text, d.sources, d.en);
        effect(d.effect);
        canvas.dataset.mood = d.mood;
        if (d.affect) avatar.setAffect(d.affect);
        // Views without the audio lease (e.g. the Studio preview) act on the start event.
        act(d.id, d.reaction, d.role, d.intensity);
        playEffect(fxDirector.offer(speechEffect(d)));
        if (isDrinkCue(d)) { drinkSip(d); roomReact(drinkReactionAsset(d), `drink:${d.id}`); }
        roomReact(speechReactionAsset(d), `speech:${d.id}`);
        if (d.comment) showPicked(d.comment);
        else if (pickedText) hidePicked(1500);
    }
    // A short sound for a viewer comment's reaction (only on the page that holds the voice, so it airs once).
    if (m.type === 'reflex' && d.source === 'comment') commentSE(d.reaction);
    // Instant wordless reflex (comment picked / game event) while waiting for the answer. Never over speech.
    if (m.type === 'reflex' && !onAir && !current && Object.hasOwn(REACTIONS, d.reaction)) {
        act(`reflex-${m.at}`, d.reaction, 'host');
        settle(d.reaction === 'listen' ? 'comment' : 'host', 2200);
    }
    if (m.type === 'speech_ended') {
        onAir = false;
        fadeCaption();
        settle(d.role || speakingRole);
        if (pickedText && speakingRole !== 'comment') hidePicked(4500);
    }
    if (m.type === 'cancel' || m.type === 'stop') {
        if (m.type === 'stop') { audienceState = { ...audienceState, running: false }; decisionView.setState({ running: false }); actionLog.setState({ running: false }); renderParticipation(); gameHud(gameShowKey ? audienceState[gameShowKey] : null); } // the talk look (stopped: no game on screen)
        onAir = false;
        if (m.type === 'cancel') fadeCaption(600);
        fxDirector.clear(); fxLayer.clear();
        if (m.type === 'cancel' && d?.reason === 'voice_handoff') fadeCancel(); else cancel();
        settle('host');
        if (pickedText) hidePicked(2500);
        if (m.type === 'stop')
            setCaption(d.reason === 'show_completed' ? '今夜も、いっしょに過ごしてくれてありがとう。' : '配信を停止しています。');
    }
    if (m.type === 'speech_ended' && current?.id === d.id)
        cancel();
};
// OBS browser sources normally permit autoplay. Regular browsers still require the visible button.
if (!preview)
    setTimeout(() => { void enableAudio(); }, 700);

// ---- NOA BLOCKS ----------------------------------------------------------------------------------------------------
// Only the audio-lease owner (OBS's stage) runs the game and reports it; every other view redraws the reported board.
let blocks = null, blocksRt = null, runningRound = null;
const PIECES = { line: [[0, 0], [1, 0], [2, 0], [3, 0]], square: [[0, 0], [1, 0], [0, 1], [1, 1]], arrow: [[1, 0], [0, 1], [1, 1], [2, 1]], leftHook: [[0, 0], [0, 1], [1, 1], [2, 1]], rightHook: [[2, 0], [0, 1], [1, 1], [2, 1]], leftZag: [[0, 0], [1, 0], [1, 1], [2, 1]], rightZag: [[1, 0], [2, 0], [0, 1], [1, 1]] };
const PIECE_COLORS = { line: '#35d8ff', square: '#ffd23a', arrow: '#b464ff', leftHook: '#3d6bff', rightHook: '#ff9a2e', leftZag: '#ff4a6a', rightZag: '#47e07a' };
const mmss = ms => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
// Viewer screen: only the big moments, briefly (the full event list lives in the Studio).
const TOAST = { line_clear: e => (e.facts?.count ?? 1) >= 2 ? [`${e.facts.count}ライン消し！`, ''] : null, danger_enter: () => ['危険ゾーン！', 'warn'], danger_exit: () => ['立て直した！', ''], game_over: () => ['ゲームオーバー', 'warn'] };
let lastToast = null;
function toast(e) {
    const key = e ? `${e.type}:${e.gameTimeMs}` : null;
    if (!e || key === lastToast) return;
    lastToast = key;
    if (fxOn && e.type === 'line_clear' && (e.facts?.count ?? 1) >= 2) fxLayer.flash();
    const t = TOAST[e.type]?.(e); if (!t) return;
    const old = $('blocks-toast'), el = old.cloneNode(false); // a fresh node restarts the animation
    el.textContent = t[0]; el.className = `blocks-toast ${t[1]}`; el.hidden = false; old.replaceWith(el);
}
/** The one number that matters during a round: distance to the same-speed personal best. */
function targetText(st) {
    const best = st.personalBest, lines = st.lines;
    if (st.phase === 'intro' || st.phase === 'between') return best === null ? `${st.speedLabel}は初記録チャレンジ` : `目標 ${best}ライン超え`;
    if (best === null) return st.phase === 'results' ? `初記録 ${lines}ライン` : '初記録チャレンジ';
    if (lines > best) return `自己ベスト更新中！ +${lines - best}`;
    if (lines === best) return '自己ベストに並んだ！';
    return `自己ベストまで あと${best - lines}ライン`;
}
function drawNext(type) {
    const c = $('blocks-next'), g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
    const cells = PIECES[type]; if (!cells) return;
    const w = Math.max(...cells.map(p => p[0])) + 1, h = Math.max(...cells.map(p => p[1])) + 1, s = 24, ox = (c.width - w * s) / 2, oy = (c.height - h * s) / 2;
    g.fillStyle = PIECE_COLORS[type]; for (const [x, y] of cells) g.fillRect(ox + x * s + 1, oy + y * s + 1, s - 2, s - 2);
}
function drawMirror(board) {
    const c = $('blocks-mirror'), g = c.getContext('2d'), s = c.width / COLS; g.fillStyle = '#060b18'; g.fillRect(0, 0, c.width, c.height);
    if (!Array.isArray(board)) return;
    g.fillStyle = '#5c7cff'; for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (board[y]?.[x]) g.fillRect(x * s + 1, y * s + 1, s - 2, s - 2);
}
function blocksHud(st) {
    if (!st) return;
    st.resultsSeenAt = st.phase === 'results' ? (blocks?.phase === 'results' ? blocks.resultsSeenAt : Date.now()) : null;
    playEffect(fxDirector.offer(gameEffect(blocks, st)));
    if (st.phase === 'intro' && blocks?.phase !== 'intro') fxLayer.clear();
    blocks = st;
    canvas.classList.add('blocks-mode');
    if (roomOn) applyTheme(); // NOA BLOCKS keeps the classic look
    for (const id of ['blocks-top', 'blocks-panel', 'blocks-bottom', 'desk']) $(id).hidden = false;
    $('b-mode').textContent = st.speedLabel; $('b-score').textContent = st.score.toLocaleString('ja-JP'); $('b-lines').textContent = String(st.lines); $('b-round').textContent = `${st.round} / ${st.maxRounds}`;
    const goals = [[st.personalBest === null ? `初記録を作る（${st.speedLabel}）` : `自己ベスト更新（${st.speedLabel}：${st.personalBest}ライン）`, !!st.lastResult?.newBest && st.lastResult.roundId === st.roundId], [`${st.maxRounds}ラウンド遊ぶ（いま ${st.round}）`, st.phase === 'done']];
    $('b-goals').replaceChildren(...goals.map(([t, done]) => { const li = document.createElement('li'); li.className = done ? 'done' : 'todo'; li.textContent = t; return li; }));
    $('b-target').textContent = targetText(st);
    toast(st.recent?.at(-1));
    drawNext(st.nextPiece);
    const banner = st.phase === 'intro' ? `${st.round}回戦 まもなく開始` : st.phase === 'playing' && !st.endsAt ? 'ボードを準備中…' : st.phase === 'results' && st.lastResult ? `${st.lastResult.lines}ライン${st.lastResult.previousBest === null ? '　初記録！' : st.lastResult.newBest ? '　自己ベスト更新！' : ''}` : st.phase === 'between' ? '次のラウンドまで少し休憩' : st.phase === 'done' ? 'おつかれさま！' : '';
    $('blocks-banner').hidden = !banner; $('blocks-banner').textContent = banner;
    const runner = !!lease && wantsAudio;
    document.body.classList.toggle('blocks-viewer', !runner);
    if (!runner) { drawMirror(st.board); return; }
    if (st.phase === 'playing' && st.roundId && st.roundId !== runningRound) {
        blocksRt ??= new NoaBlocks($('blocks-board'), { onSnapshot: (snap, events) => {
            if (!lease || snap.roundId !== runningRound) return;
            void api('/api/renderer/game', { lease, roundId: snap.roundId, snapshot: snap, events, summary: blocksRt.summary() }).catch(() => { });
        } });
        runningRound = st.roundId; blocksRt.start({ roundId: st.roundId, seed: st.seed, speed: st.speed });
    } else if (st.phase !== 'playing' && runningRound) { blocksRt?.stop(); runningRound = null; }
}
setInterval(() => {
    if (!blocks) return;
    const full = mmss((blocks.roundSeconds || 180) * 1000), left = blocks.phase === 'playing' && blocks.endsAt ? blocks.endsAt - Date.now() : null;
    $('b-time').textContent = left !== null ? mmss(left) : ['intro', 'playing'].includes(blocks.phase) ? full : '00:00';
    $('b-time').classList.toggle('low', left !== null && left <= 30000);
    if (runningRound && !(lease && wantsAudio)) { blocksRt?.pause(); runningRound = null; } // Lost the lease: stop driving the game.
}, 250);
