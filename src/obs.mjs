import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { SWITCH_NAMES } from './switch-setup.mjs';
import { effectiveGameLayout } from '../public/stage-theme.mjs';
export const obsAuth = (password, salt, challenge) => { const hash = x => createHash('sha256').update(x).digest('base64'); return hash(hash(password + salt) + challenge); };
const STAGE_LAYERS = { 'JVS Background': 'background', 'JVS Avatar': 'avatar', 'JVS Comment': 'comments', 'JVS Subtitle': 'subtitles', 'JVS Overlay': 'overlay' };
const browserInput = input => input?.inputKind === 'browser_source' || input?.unversionedInputKind === 'browser_source';
function stageOwned(settings, origin, layout) {
    try {
        const url = new URL(settings.url), params = new URLSearchParams([...new URLSearchParams(url.hash.slice(1)), ...url.searchParams]);
        if (url.origin !== new URL(origin).origin || url.pathname !== '/stage' || url.username || url.password || !new URLSearchParams(url.hash.slice(1)).get('token')) return false;
        return layout === 'game' ? params.get('layout') === 'game' && !params.has('layer')
            : layout ? params.get('layer') === layout : !params.has('layer') && params.get('layout') !== 'game';
    } catch { return false; }
}
/** The origin of a Studio stage page on this machine (localhost, /stage, a view token, the expected layout), else null. */
function staleLocalStage(settings, layout) {
    try {
        const url = new URL(settings.url);
        if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:') return null;
        return stageOwned(settings, url.origin, layout) ? url.origin : null;
    } catch { return null; }
}
// Overlay spots in the 1920x1080 game scene (see public/stage.css). Keep the chat under the capture
// throughout the game programme, including opening talk; the avatar remains in its right-hand safe area.
export const OVERLAY_GAME_CHAT = Object.freeze({ positionX: 48, positionY: 772 });
export const OVERLAY_TALK_CHAT = Object.freeze({ positionX: 1340, positionY: 650 });
// Standby screens the operator made (OBS scenes holding a full-screen image; data/screens/*.png). 'show' = the programme.
export const SCREENS = Object.freeze({ standby: 'Noa 配信準備中', away: 'Noa 少し離席中', tuning: 'Noa 機材調整中', ended: 'Noa 配信終了' });
export const OVERLAY_GAME_ACTIONS = Object.freeze({ positionX: 612, positionY: 772 });
// STAGE_THEME=room (public/stage-theme.mjs ROOM_BOXES, the Noa OBS asset pack's coordinates): the game window fills the
// frame's 16:9 window and the overlays land on the frame's content boxes at those sizes (a browser source's size is its
// input setting, so it changes with the layout). Commands: a slim strip along the bottom of the game window, clear of
// Noa, the comment panel and the subtitles (the game's own HUD is at its top).
export const ROOM_GAME_CAPTURE = Object.freeze({ positionX: 32, positionY: 140, boundsWidth: 1376, boundsHeight: 774 });
const roomSpot = (x, y, width, height) => Object.freeze({ transform: Object.freeze({ positionX: x, positionY: y, scaleX: 1, scaleY: 1, boundsType: 'OBS_BOUNDS_NONE' }), size: Object.freeze({ width, height }) });
export const ROOM_OVERLAY_TALK_CHAT = roomSpot(1404, 296, 464, 284);
export const ROOM_OVERLAY_GAME_CHAT = roomSpot(1454, 636, 424, 182);
export const ROOM_OVERLAY_GAME_ACTIONS = roomSpot(44, 870, 780, 36);
// ROOM_GAME_LAYOUT=front (ROOM_BOXES.front): a bigger game window with Noa in front of its lower-right corner. The game
// capture goes to the bottom of the scene and the stage page above it (transparent over the game window), so Noa, drawn by
// the stage, stands in front of the game. The chat takes the right-hand column under the ad; the commands keep their strip.
export const ROOM_FRONT_GAME_CAPTURE = Object.freeze({ positionX: 24, positionY: 96, boundsWidth: 1456, boundsHeight: 819 });
export const ROOM_FRONT_OVERLAY_GAME_CHAT = roomSpot(1512, 548, 384, 500);
// ROOM_GAME_LAYOUT=full (ROOM_BOXES.full): the game fills the canvas under the stage; the chat runs up the left edge
// (older rows fade, #fade=1) and the commands take a strip between it and the status bar.
export const ROOM_FULL_GAME_CAPTURE = Object.freeze({ positionX: 0, positionY: 0, boundsWidth: 1920, boundsHeight: 1080 });
export const ROOM_FULL_OVERLAY_GAME_CHAT = roomSpot(24, 560, 496, 390);
export const ROOM_FULL_OVERLAY_GAME_ACTIONS = roomSpot(24, 958, 700, 32);
// ROOM_GAME_LAYOUT=frame (ROOM_BOXES.frame): the game in its 1600x900 frame under the stage; the chat inside the column's
// LIVE CHAT panel (name over text, #style=card); the commands in a slim strip along the game's bottom edge.
export const ROOM_FRAME_GAME_CAPTURE = Object.freeze({ positionX: 8, positionY: 8, boundsWidth: 1680, boundsHeight: 945 });
export const ROOM_FRAME_OVERLAY_GAME_CHAT = roomSpot(1712, 172, 188, 240);
export const ROOM_FRAME_OVERLAY_GAME_ACTIONS = roomSpot(32, 924, 700, 24);
// ROOM_GAME_LAYOUT=wide (ROOM_BOXES.wide): the game at 1600x900 top-left under the stage; the chat in the right-hand
// column under Noa as cards (#style=card, the column is narrow); the commands in a strip above the game's bottom fifth.
export const ROOM_WIDE_GAME_CAPTURE = Object.freeze({ positionX: 8, positionY: 8, boundsWidth: 1600, boundsHeight: 900 });
export const ROOM_WIDE_OVERLAY_GAME_CHAT = roomSpot(1620, 644, 292, 200);
export const ROOM_WIDE_OVERLAY_GAME_ACTIONS = roomSpot(24, 668, 700, 32);

export class OBS {
    constructor(c, WebSocketImpl = WebSocket) { this.c = c; this.WS = WebSocketImpl; this.ws = null; this.pending = new Map(); this.ready = false; this.owned = false; this.connecting = null; this.operations = Promise.resolve(); this.eventSubscriptions = 0; this.onEvent = null; }
    async connect() {
        if (this.ready)
            return;
        if (this.connecting)
            return this.connecting;
        this.connecting = new Promise((resolve, reject) => {
            const ws = new this.WS(this.c.obsURL);
            this.ws = ws;
            const timer = setTimeout(() => { ws.close(); reject(new Error('OBS connection timeout')); }, 6000);
            const fail = () => { clearTimeout(timer); this.ready = false; reject(new Error('OBS disconnected')); for (const v of this.pending.values())
                v.reject(new Error('OBS disconnected')); this.pending.clear(); };
            ws.addEventListener('error', fail);
            ws.addEventListener('close', fail);
            ws.addEventListener('message', event => {
                try {
                    const m = JSON.parse(String(event.data));
                    if (m.op === 0) {
                        const auth = m.d.authentication;
                        ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: this.eventSubscriptions, ...(auth ? { authentication: obsAuth(this.c.obsPassword, auth.salt, auth.challenge) } : {}) } }));
                    }
                    else if (m.op === 2) {
                        clearTimeout(timer);
                        this.ready = true;
                        resolve();
                    }
                    else if (m.op === 5) this.onEvent?.(m.d); // only with eventSubscriptions (src/control.mjs volume meters)
                    else if (m.op === 7) {
                        const p = this.pending.get(m.d.requestId);
                        if (!p)
                            return;
                        this.pending.delete(m.d.requestId);
                        if (m.d.requestStatus?.result)
                            p.resolve(m.d.responseData || {});
                        else
                            p.reject(new Error(`OBS ${m.d.requestType} failed (${m.d.requestStatus?.code})`));
                    }
                }
                catch {
                    fail();
                    ws.close();
                }
            });
        }).finally(() => { this.connecting = null; });
        return this.connecting;
    }
    async call(requestType, requestData = {}) {
        await this.connect();
        const requestId = randomUUID();
        return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`OBS ${requestType} timeout`)); }, 5000); this.pending.set(requestId, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } }); try {
            this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
        }
        catch (e) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            reject(e);
        } });
    }
    serialize(fn) { const p = this.operations.then(fn, fn); this.operations = p.catch(() => { }); return p; }
    async assertOutputsStopped() {
        const stream = await this.call('GetStreamStatus'), record = await this.call('GetRecordStatus');
        const replay = await this.call('GetReplayBufferStatus').catch(error => {
            // This request reports unavailable replay buffers as InvalidResourceState
            // (604), not OutputDisabled (504): obs-websocket RequestHandler_Outputs.cpp.
            if (error.message === 'OBS GetReplayBufferStatus failed (604)') return { outputActive: false };
            throw error;
        });
        // Missing status is not proof that an output is stopped.
        if (stream.outputActive !== false || stream.outputReconnecting || record.outputActive !== false || replay.outputActive !== false)
            throw new Error('配信・録画・リプレイバッファを停止してからOBSを準備してください。');
    }
    /** Whether a local Studio answers at origin (any HTTP reply counts); a refused or silent port does not. */
    async originAnswers(origin) {
        if (this.c.originAnswers) return this.c.originAnswers(origin);
        try { await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(800) }); return true; } catch { return false; }
    }
    async inspectStages(origin, { mode } = {}) {
        const layouts = new Map([[this.c.obsInput, null], ...Object.entries(STAGE_LAYERS)]);
        if (this.c.game) layouts.set(this.gameSources().stage, 'game');
        const targets = new Set(this.c.game ? [this.gameSources().stage] : mode === 'layered' ? Object.keys(STAGE_LAYERS) : [this.c.obsInput]);
        const inputs = (await this.call('GetInputList')).inputs || [], unused = [];
        for (const input of inputs) {
            if (!layouts.has(input.inputName)) continue;
            const settings = browserInput(input) ? (await this.call('GetInputSettings', { inputName: input.inputName })).inputSettings : null;
            let owned = settings && stageOwned(settings, origin, layouts.get(input.inputName));
            if (targets.has(input.inputName) && !owned) {
                const other = settings ? staleLocalStage(settings, layouts.get(input.inputName)) : null;
                // A Studio stage of this machine whose Studio is gone (an old port): re-point it here.
                if (other && !await this.originAnswers(other)) owned = true;
                else throw new Error(other
                    ? `OBSの専用ソース「${input.inputName}」は、いま動いている別のStudio（${new URL(other).host}）の配信画面です。そちらのStudioを終了してから、もう一度準備してください。`
                    : `OBSの「${input.inputName}」はStudioの専用ソースとして使えない設定です。OBSでそのソースの名前を変えるか削除してから、もう一度準備してください（Studioが作り直します）。`);
            }
            if (owned && !targets.has(input.inputName) && settings.shutdown !== true)
                unused.push({ name: input.inputName, layout: layouts.get(input.inputName) });
        }
        return unused;
    }
    async waitForInactiveStage(sourceName) {
        const until = performance.now() + 1500;
        while (performance.now() < until) {
            const timer = new AbortController();
            let active;
            try {
                // Bound the whole observation window, including a slow read-only RPC.
                active = await Promise.race([
                    this.call('GetSourceActive', { sourceName }),
                    pause(Math.max(0, until - performance.now()), null, { signal: timer.signal }),
                ]);
            } finally { timer.abort(); }
            if (active?.videoActive === false && active.videoShowing === false) return true;
            if (typeof active?.videoActive !== 'boolean' || typeof active.videoShowing !== 'boolean') return false;
            const remaining = until - performance.now();
            if (remaining <= 0) return false;
            await pause(Math.min(250, remaining));
        }
        return false;
    }
    prepare(origin, options = {}) { return this.serialize(async () => {
        await this.assertOutputsStopped();
        const unused = await this.inspectStages(origin, options);
        await this.assertOutputsStopped();
        const result = await this.prepareImpl(origin, options);
        // Only retire an app-owned source after selecting the replacement scene. A visible
        // source (including OBS Studio Mode's preview) stays untouched. No URL or token is logged.
        for (const stage of unused) {
            if (!await this.waitForInactiveStage(stage.name)) continue;
            const current = (await this.call('GetInputSettings', { inputName: stage.name })).inputSettings;
            if (!stageOwned(current, origin, stage.layout) || current.shutdown === true) continue;
            await this.assertOutputsStopped();
            await this.call('SetInputSettings', { inputName: stage.name, inputSettings: { shutdown: true }, overlay: true });
        }
        // This confirms configuration only. A reloaded Stage must still reacquire its
        // audio lease and prove playback through the existing renderer readiness checks.
        return result;
    }); }
    async prepareImpl(origin, { mode } = {}) {
        if (this.c.game) return this.prepareGame(origin);
        const scenes = await this.call('GetSceneList');
        if (!scenes.scenes?.some(x => x.sceneName === this.c.obsScene))
            await this.call('CreateScene', { sceneName: this.c.obsScene });

        if (mode === 'layered') {
            const transparentCss = 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }';
            const rendererParam = this.c.obsRendererToken ? `&output=obs&rendererKey=${this.c.obsRendererToken}` : '';
            const layers = [
                {
                    id: 'background',
                    name: 'JVS Background',
                    url: `${origin}/stage?layer=background#token=${this.c.viewToken}`,
                    css: 'body { margin: 0px auto; overflow: hidden; }',
                    rerouteAudio: false,
                    enabled: true
                },
                {
                    id: 'avatar',
                    name: 'JVS Avatar',
                    url: `${origin}/stage?layer=avatar#token=${this.c.viewToken}${this.c.vtsEnabled ? '&avatar=external' : ''}`,
                    css: transparentCss,
                    rerouteAudio: false,
                    enabled: !this.c.vtsEnabled
                },
                {
                    id: 'comments',
                    name: 'JVS Comment',
                    url: `${origin}/stage?layer=comments#token=${this.c.viewToken}`,
                    css: transparentCss,
                    rerouteAudio: false,
                    enabled: true
                },
                {
                    id: 'subtitles',
                    name: 'JVS Subtitle',
                    url: `${origin}/stage?layer=subtitles#token=${this.c.viewToken}${rendererParam}`,
                    css: transparentCss,
                    rerouteAudio: true,
                    enabled: true
                },
                {
                    id: 'overlay',
                    name: 'JVS Overlay',
                    url: `${origin}/stage?layer=overlay#token=${this.c.viewToken}`,
                    css: transparentCss,
                    rerouteAudio: false,
                    enabled: true
                }
            ];

            const inputs = await this.call('GetInputList');
            const existingMap = new Map((inputs.inputs || []).map(x => [x.inputName, x]));
            const items = await this.call('GetSceneItemList', { sceneName: this.c.obsScene });
            const existingItems = new Set((items.sceneItems || []).map(x => x.sourceName));

            for (const layer of layers) {
                const settings = {
                    url: layer.url,
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    reroute_audio: layer.rerouteAudio,
                    shutdown: true,
                    restart_when_active: false,
                    css: layer.css
                };
                const existing = existingMap.get(layer.name);
                if (existing) {
                    await this.call('SetInputSettings', { inputName: layer.name, inputSettings: settings, overlay: true });
                    if (!existingItems.has(layer.name)) {
                        await this.call('CreateSceneItem', { sceneName: this.c.obsScene, sourceName: layer.name, sceneItemEnabled: layer.enabled });
                    } else {
                        const item = items.sceneItems.find(x => x.sourceName === layer.name);
                        if (item.sceneItemEnabled !== layer.enabled)
                            await this.call('SetSceneItemEnabled', { sceneName: this.c.obsScene, sceneItemId: item.sceneItemId, sceneItemEnabled: layer.enabled });
                    }
                } else {
                    await this.call('CreateInput', {
                        sceneName: this.c.obsScene,
                        inputName: layer.name,
                        inputKind: 'browser_source',
                        inputSettings: settings,
                        sceneItemEnabled: layer.enabled
                    });
                }
                if (layer.rerouteAudio) {
                    await this.call('SetInputMute', { inputName: layer.name, inputMuted: false }).catch(() => {});
                }
            }

            await this.call('SetCurrentProgramScene', { sceneName: this.c.obsScene });
            return {
                scene: this.c.obsScene,
                mode: 'layered',
                layers: layers.map(l => ({ name: l.name, url: l.url, enabled: l.enabled }))
            };
        }

        const settings = { url: `${origin}/stage#token=${this.c.viewToken}${this.c.vtsEnabled ? '&avatar=external' : ''}${this.themeParams()}${this.c.obsRendererToken ? `&output=obs&rendererKey=${this.c.obsRendererToken}` : ''}`, width: 1920, height: 1080, fps: 30, reroute_audio: true, shutdown: true, restart_when_active: false, css: 'body { margin: 0; overflow: hidden; }' };
        const inputs = await this.call('GetInputList');
        const existing = inputs.inputs?.find(x => x.inputName === this.c.obsInput);
        if (existing) {
            if (existing.inputKind !== 'browser_source' && existing.unversionedInputKind !== 'browser_source')
                throw new Error('OBS input name already belongs to another source type');
            await this.call('SetInputSettings', { inputName: this.c.obsInput, inputSettings: settings, overlay: true });
            const items = await this.call('GetSceneItemList', { sceneName: this.c.obsScene });
            const item = items.sceneItems?.find(x => x.sourceName === this.c.obsInput);
            if (!item)
                await this.call('CreateSceneItem', { sceneName: this.c.obsScene, sourceName: this.c.obsInput, sceneItemEnabled: true });
            else if (item.sceneItemEnabled === false)
                await this.call('SetSceneItemEnabled', { sceneName: this.c.obsScene, sceneItemId: item.sceneItemId, sceneItemEnabled: true });
        }
        else
            await this.call('CreateInput', { sceneName: this.c.obsScene, inputName: this.c.obsInput, inputKind: 'browser_source', inputSettings: settings, sceneItemEnabled: true });
        await this.call('SetInputMute', { inputName: this.c.obsInput, inputMuted: false });
        await this.call('SetCurrentProgramScene', { sceneName: this.c.obsScene });
        return { scene: this.c.obsScene, input: this.c.obsInput };
    }
    /** OBS names for the programme's game (games/<id>/game.json: title, capture). A 'switch'-captured game has no window
     * of its own: its picture and sound are the Switch page's inputs, reused in the game's scene. */
    gameSources() {
        const g = this.c.game, t = g.title, capture = { kind: 'window', ...(g.capture || {}) }, sw = capture.kind === 'switch';
        return { scene: `${this.c.obsScene} - ${t}`, stage: `${this.c.obsInput} (${t})`, window: sw ? SWITCH_NAMES.video : `${t} Window`, audio: sw ? SWITCH_NAMES.audio : `${t} Audio`, capture };
    }
    /** Optional chat and command overlays (OBS_CHAT_SOURCE / OBS_ACTIONS_SOURCE, e.g. scripts/chat-overlay.mjs) in the
     * game scene. Chat stays in the safe area under the game frame throughout the programme. Commands
     * hide during opening talk and reappear beside chat while playing. Only position and visibility change; a missing source is skipped. -> whether anything was placed. */
    async placeOverlays(talk) {
        const chat = this.c.obsChatSource, actions = this.c.obsActionsSource;
        if (!this.ready || (!chat && !actions) || !this.c.game) return false;
        const scene = this.gameSources().scene;
        const items = (await this.call('GetSceneItemList', { sceneName: scene })).sceneItems || [];
        const item = name => name && items.find(x => x.sourceName === name);
        const c = item(chat), a = item(actions);
        if (this.room()) {
            const spot = talk ? ROOM_OVERLAY_TALK_CHAT : this.gameChatSpot();
            if (c) { await this.call('SetInputSettings', { inputName: chat, inputSettings: spot.size, overlay: true }); await this.call('SetSceneItemTransform', { sceneName: scene, sceneItemId: c.sceneItemId, sceneItemTransform: spot.transform }); }
            if (a && !talk) { const as = this.gameActionsSpot(); if (['full', 'frame', 'wide'].includes(this.gameLayout())) await this.call('SetInputSettings', { inputName: actions, inputSettings: as.size, overlay: true }); await this.call('SetSceneItemTransform', { sceneName: scene, sceneItemId: a.sceneItemId, sceneItemTransform: as.transform }); }
            if (a) await this.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: a.sceneItemId, sceneItemEnabled: !talk && this.c.game?.player !== 'operator' });
            return !!(c || a);
        }
        if (c) await this.call('SetSceneItemTransform', { sceneName: scene, sceneItemId: c.sceneItemId, sceneItemTransform: talk ? OVERLAY_TALK_CHAT : OVERLAY_GAME_CHAT });
        if (a) await this.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: a.sceneItemId, sceneItemEnabled: !talk && this.c.game?.player !== 'operator' });
        return !!(c || a);
    }
    /** The chat box and Noa's commands as the Studio's own pages (public/overlay-*.html, fed by the Studio's receivers and
     * run-log feed): created when missing, re-pointed when they exist (a source that is not a browser source is left
     * alone), and placed for play — placeOverlays() moves them for the talk. */
    async ensureOverlays(origin, scene) {
        const room = this.room(), wanted = [[this.c.obsChatSource, 'overlay-chat', room ? this.gameChatSpot() : OVERLAY_GAME_CHAT], [this.c.obsActionsSource, 'overlay-actions', room ? this.gameActionsSpot() : OVERLAY_GAME_ACTIONS]].filter(([name]) => name);
        if (!wanted.length) return;
        const inputs = new Map(((await this.call('GetInputList')).inputs || []).map(x => [x.inputName, x]));
        for (const [name, page, spot] of wanted) {
            const settings = room ? { url: `${origin}/${page}.html#token=${this.c.viewToken}&theme=room${page === 'overlay-chat' ? ({ full: '&fade=1', frame: '&style=card', wide: '&style=card' }[this.gameLayout()] ?? '') : ''}`, ...spot.size, fps: 30, reroute_audio: false, css: '' }
                : { url: `${origin}/${page}.html#token=${this.c.viewToken}`, width: 556, height: 175, fps: 30, reroute_audio: false, css: '' }, existing = inputs.get(name);
            if (existing && !browserInput(existing)) continue;
            if (existing) await this.call('SetInputSettings', { inputName: name, inputSettings: settings, overlay: true });
            const items = (await this.call('GetSceneItemList', { sceneName: scene })).sceneItems || [];
            let id = items.find(x => x.sourceName === name)?.sceneItemId;
            if (!id) id = existing ? (await this.call('CreateSceneItem', { sceneName: scene, sourceName: name, sceneItemEnabled: true }))?.sceneItemId
                : (await this.call('CreateInput', { sceneName: scene, inputName: name, inputKind: 'browser_source', inputSettings: settings, sceneItemEnabled: true }))?.sceneItemId;
            if (id) await this.call('SetSceneItemTransform', { sceneName: scene, sceneItemId: id, sceneItemTransform: room ? spot.transform : spot });
        }
    }
    /** The scene a game programme airs in (the Switch page lets these scenes share its inputs). */
    gameSceneName(name) { return typeof name === 'string' && name.startsWith(`${this.c.obsScene} - `); }
    /** A game from games/<id> runs outside the browser: its own scene (the Noa scene is left as it is) with the stage in
     * the game layout, and the game window captured over the stage's frame (1120x630 at 48,120; see public/stage.css).
     * ScreenCaptureKit window capture (the legacy window_capture relies on an API removed in current macOS); a game that
     * relaunches between runs gets a new window, so refreshGameWindow() re-points the capture. The manifest's cropTopPx
     * takes off the title bar (28 pt = 56 px on Retina). Nothing here starts a stream or touches stream keys. */
    async prepareGame(origin) {
        const names = this.gameSources(), cap = names.capture;
        if (cap.kind === 'switch') return this.prepareSwitchGame(origin, names);
        const scene = names.scene, stageName = names.stage, gameName = names.window;
        const scenes = await this.call('GetSceneList');
        if (!scenes.scenes?.some(x => x.sceneName === scene)) await this.call('CreateScene', { sceneName: scene });
        const stage = this.gameStageSettings(origin);
        const game = { type: 1, show_cursor: false, show_hidden_windows: true, hide_obs: true };
        const inputs = new Map(((await this.call('GetInputList')).inputs || []).map(x => [x.inputName, x]));
        const items = async () => (await this.call('GetSceneItemList', { sceneName: scene })).sceneItems || [];
        for (const [name, kind, settings] of [[stageName, 'browser_source', stage], [gameName, 'screen_capture', game]]) {
            const existing = inputs.get(name);
            if (existing && existing.inputKind !== kind && existing.unversionedInputKind !== kind) throw new Error(`OBS input ${name} already belongs to another source type`);
            if (existing) {
                await this.call('SetInputSettings', { inputName: name, inputSettings: settings, overlay: true });
                const item = (await items()).find(x => x.sourceName === name);
                if (!item) await this.call('CreateSceneItem', { sceneName: scene, sourceName: name, sceneItemEnabled: true });
                else if (name === stageName && item.sceneItemEnabled === false)
                    await this.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: item.sceneItemId, sceneItemEnabled: true });
            } else await this.call('CreateInput', { sceneName: scene, inputName: name, inputKind: kind, inputSettings: settings, sceneItemEnabled: true });
        }
        const list = await items(), gameItem = list.find(x => x.sourceName === gameName), stageItem = list.find(x => x.sourceName === stageName);
        // The stage fills the canvas at the bottom; the game sits on top of it, inside the frame. In the front layout the
        // game goes to the bottom instead, under the stage, which is transparent over it and draws Noa in front.
        const bottom = this.overGame() ? gameItem : stageItem;
        if (bottom) await this.call('SetSceneItemIndex', { sceneName: scene, sceneItemId: bottom.sceneItemId, sceneItemIndex: 0 });
        if (gameItem) await this.call('SetSceneItemTransform', { sceneName: scene, sceneItemId: gameItem.sceneItemId, sceneItemTransform: this.gameCaptureTransform(cap) });
        await this.call('SetInputMute', { inputName: stageName, inputMuted: false });
        await this.ensureOverlays(origin, scene);
        // Game sound (GAME_AUDIO=true): the game app's audio (manifest capture.bundleId) via ScreenCaptureKit, under Noa's voice.
        const audioName = names.audio, audio = inputs.get(audioName);
        if (this.c.gameAudio && cap.bundleId) {
            const settings = { type: 1, application: cap.bundleId };
            if (audio) await this.call('SetInputSettings', { inputName: audioName, inputSettings: settings, overlay: true });
            else await this.call('CreateInput', { sceneName: scene, inputName: audioName, inputKind: 'sck_audio_capture', inputSettings: settings, sceneItemEnabled: true });
            await this.call('SetInputVolume', { inputName: audioName, inputVolumeDb: this.gameAudioDb(cap) });
            await this.call('SetInputMute', { inputName: audioName, inputMuted: false });
        } else if (audio) await this.call('SetInputMute', { inputName: audioName, inputMuted: true });
        await this.prepareBgm(scene, inputs);
        const window = await this.refreshGameWindow().catch(() => null);
        const muted = await this.muteGlobalAudio();
        await this.call('SetCurrentProgramScene', { sceneName: scene });
        this.programmeScene = scene;
        return { scene, input: stageName, game: gameName, window, mutedGlobalAudio: muted };
    }
    /** Whether the Studio's on-stream look is Noa's night room (STAGE_THEME=room). */
    room() { return this.c.stageTheme === 'room'; }
    /** The person's mic for a voice handoff (src/control.mjs, OBS_HUMAN_MIC_SOURCE): mute or open it, then read the state
     * back; an unconfirmed change throws, so the caller never assumes a mic is closed (or open) when it is not. */
    async setHumanMic(inputName, on) {
        if (!inputName) throw new Error('OBS_HUMAN_MIC_SOURCE is not set');
        await this.call('SetInputMute', { inputName, inputMuted: !on });
        const { inputMuted } = await this.call('GetInputMute', { inputName });
        if (inputMuted !== !on) throw new Error(`OBS did not ${on ? 'open' : 'mute'} ${inputName}`);
    }
    /** The room theme's game layout (ROOM_GAME_LAYOUT): 'side', 'front' (Noa in front of the game), 'full' (full-screen game), 'frame' or 'wide'. */
    gameLayout() { return this.room() ? effectiveGameLayout(this.c.roomGameLayout, this.c.game) : 'side'; }
    /** The stage is above the game (front, full): the capture goes to the bottom of the scene. */
    overGame() { return this.gameLayout() !== 'side'; }
    gameChatSpot() { return { front: ROOM_FRONT_OVERLAY_GAME_CHAT, full: ROOM_FULL_OVERLAY_GAME_CHAT, frame: ROOM_FRAME_OVERLAY_GAME_CHAT, wide: ROOM_WIDE_OVERLAY_GAME_CHAT }[this.gameLayout()] ?? ROOM_OVERLAY_GAME_CHAT; }
    gameActionsSpot() { return { full: ROOM_FULL_OVERLAY_GAME_ACTIONS, frame: ROOM_FRAME_OVERLAY_GAME_ACTIONS, wide: ROOM_WIDE_OVERLAY_GAME_ACTIONS }[this.gameLayout()] ?? ROOM_OVERLAY_GAME_ACTIONS; }
    /** The game window in the game scene: inside the stage's frame (classic 1120x630 at 48,120; room 1376x774 at 32,140). */
    gameCaptureTransform(cap) {
        const box = { front: ROOM_FRONT_GAME_CAPTURE, full: ROOM_FULL_GAME_CAPTURE, frame: ROOM_FRAME_GAME_CAPTURE, wide: ROOM_WIDE_GAME_CAPTURE }[this.gameLayout()] ?? (this.room() ? ROOM_GAME_CAPTURE : { positionX: 48, positionY: 120, boundsWidth: 1120, boundsHeight: 630 });
        return { positionX: box.positionX, positionY: box.positionY, cropTop: cap.cropTopPx ?? 0, cropBottom: 0, cropLeft: 0, cropRight: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: box.boundsWidth, boundsHeight: box.boundsHeight, boundsAlignment: 0 };
    }
    /** The room theme's view parameters (classic adds none): the theme, and chat=1 when a chat source sits on the comment panel. */
    themeParams(chat = false) { return this.room() ? `&theme=room${chat && this.c.obsChatSource ? '&chat=1' : ''}${this.overGame() ? `&gamelayout=${this.gameLayout()}` : ''}` : ''; }
    gameStageSettings(origin) {
        return { url: `${origin}/stage#token=${this.c.viewToken}&layout=game${this.c.streamTarget === 'simulcast' ? '&simulcast=1' : ''}${this.c.obsActionsSource ? '&actions=external' : ''}${this.themeParams(true)}${this.c.obsRendererToken ? `&output=obs&rendererKey=${this.c.obsRendererToken}` : ''}`, width: 1920, height: 1080, fps: 30, reroute_audio: true, shutdown: true, restart_when_active: false, css: 'body { margin: 0; overflow: hidden; }' };
    }
    /** Game sound level: the Studio setting (GAME_AUDIO_DB) over the manifest's, under Noa's voice by default. */
    gameAudioDb(cap) { return Number.isFinite(this.c.gameAudioDb) ? this.c.gameAudioDb : cap.audioVolumeDb ?? -14; }
    /** Background music (OBS_BGM_FILE): looped quietly under the voice and the game for the whole show. */
    async prepareBgm(scene, inputs) {
        const bgmName = this.c.obsBgmSource, bgm = inputs.get(bgmName);
        if (this.c.obsBgmFile) {
            const settings = { is_local_file: true, local_file: this.c.obsBgmFile, looping: true, restart_on_activate: false, close_when_inactive: false, hw_decode: false };
            if (bgm) await this.call('SetInputSettings', { inputName: bgmName, inputSettings: settings, overlay: true });
            else await this.call('CreateInput', { sceneName: scene, inputName: bgmName, inputKind: 'ffmpeg_source', inputSettings: settings, sceneItemEnabled: true });
            await this.call('SetInputVolume', { inputName: bgmName, inputVolumeDb: Math.min(0, this.c.obsBgmVolumeDb) });
            await this.call('SetInputMute', { inputName: bgmName, inputMuted: false });
        } else if (bgm) await this.call('SetInputMute', { inputName: bgmName, inputMuted: true });
    }
    /** An AI show carries no person: OBS's global microphone / desktop audio would air in every scene (a room's
     * voices, other apps' sounds), so they are muted here. The operator can unmute them in OBS on purpose. */
    async muteGlobalAudio() {
        const special = await this.call('GetSpecialInputs').catch(() => ({})), muted = [];
        for (const name of Object.values(special || {}).filter(Boolean)) {
            await this.call('SetInputMute', { inputName: name, inputMuted: true }); muted.push(name);
        }
        return muted;
    }
    /** A game on the Switch (capture.kind 'switch'): the game's own scene with the stage in the game layout and, inside
     * the frame, the Switch page's video input; its audio input too when game sound is on. The inputs themselves are
     * not created or re-pointed here (the Switch page owns the device choice, mute and monitoring; docs/SWITCH_MINECRAFT.md),
     * only placed as items of this scene, so the capture card is opened once and the Switch page's checks still hold. */
    async prepareSwitchGame(origin, names) {
        const scene = names.scene, stageName = names.stage, videoName = names.window, audioName = names.audio, cap = names.capture;
        const inputs = new Map(((await this.call('GetInputList')).inputs || []).map(x => [x.inputName, x]));
        if (!inputs.has(videoName)) throw new Error('Switchのキャプチャ機器が未設定です。Studioの「Switch接続」で映像と音声の機器を選んでから、もう一度準備してください。');
        if (this.c.gameAudio && !inputs.has(audioName)) throw new Error('Switchの音声機器が未設定です。「Switch接続」で音声機器を選ぶか、設定でゲーム音を切ってください。');
        const scenes = await this.call('GetSceneList');
        if (!scenes.scenes?.some(x => x.sceneName === scene)) await this.call('CreateScene', { sceneName: scene });
        const items = async () => (await this.call('GetSceneItemList', { sceneName: scene })).sceneItems || [];
        const stage = inputs.get(stageName), stageSettings = this.gameStageSettings(origin);
        if (stage && !browserInput(stage)) throw new Error(`OBS input ${stageName} already belongs to another source type`);
        if (stage) {
            await this.call('SetInputSettings', { inputName: stageName, inputSettings: stageSettings, overlay: true });
            const item = (await items()).find(x => x.sourceName === stageName);
            if (!item) await this.call('CreateSceneItem', { sceneName: scene, sourceName: stageName, sceneItemEnabled: true });
            else if (item.sceneItemEnabled === false) await this.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: item.sceneItemId, sceneItemEnabled: true });
        } else await this.call('CreateInput', { sceneName: scene, inputName: stageName, inputKind: 'browser_source', inputSettings: stageSettings, sceneItemEnabled: true });
        // The Switch inputs become items of this scene (an input may sit in several scenes); nothing about them changes.
        for (const name of [videoName, ...(this.c.gameAudio ? [audioName] : [])])
            if (!(await items()).some(x => x.sourceName === name)) await this.call('CreateSceneItem', { sceneName: scene, sourceName: name, sceneItemEnabled: true });
        const list = await items(), stageItem = list.find(x => x.sourceName === stageName), videoItem = list.find(x => x.sourceName === videoName), audioItem = list.find(x => x.sourceName === audioName);
        const bottom = this.overGame() ? videoItem : stageItem; // front layout: the picture under the stage (see prepareGame)
        if (bottom) await this.call('SetSceneItemIndex', { sceneName: scene, sceneItemId: bottom.sceneItemId, sceneItemIndex: 0 });
        if (videoItem) await this.call('SetSceneItemTransform', { sceneName: scene, sceneItemId: videoItem.sceneItemId, sceneItemTransform: this.gameCaptureTransform(cap) });
        await this.call('SetInputMute', { inputName: stageName, inputMuted: false });
        await this.ensureOverlays(origin, scene);
        // Game sound off: the audio input stays out of this scene (its mute belongs to the Switch page's record).
        if (audioItem && !this.c.gameAudio) await this.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: audioItem.sceneItemId, sceneItemEnabled: false });
        if (this.c.gameAudio) await this.call('SetInputVolume', { inputName: audioName, inputVolumeDb: this.gameAudioDb(cap) });
        await this.prepareBgm(scene, inputs);
        const muted = await this.muteGlobalAudio();
        await this.call('SetCurrentProgramScene', { sceneName: scene });
        return { scene, input: stageName, game: videoName, window: null, capture: 'switch', mutedGlobalAudio: muted };
    }
    /** Show or hide the game (window and sound) in the game's scene: hidden during the opening talk. */
    async setGameVisible(visible) {
        const names = this.gameSources();
        const items = (await this.call('GetSceneItemList', { sceneName: names.scene })).sceneItems || [];
        for (const item of items.filter(i => [names.window, names.audio].includes(i.sourceName)))
            await this.call('SetSceneItemEnabled', { sceneName: names.scene, sceneItemId: item.sceneItemId, sceneItemEnabled: !!visible });
        return items.length > 0;
    }
    /** Point the game capture at the current game window (its id changes on every relaunch). Returns the window name
     * OBS listed, or null when the game is not open (the capture then keeps its last setting). */
    async refreshGameWindow(inputName = this.gameSources().window) {
        if (this.gameSources().capture.kind !== 'window') return null; // a capture card has no window to re-point
        const { propertyItems = [] } = await this.call('GetInputPropertiesListPropertyItems', { inputName, propertyName: 'window' });
        // Only the game's own window ("[<app>] <window title>", e.g. "[Vampire Survivors] Vampire Survivors"): a browser
        // tab or Finder window with the name in its title belongs to another app and must never be captured.
        const cap = this.gameSources().capture, esc = t => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const want = new RegExp(`^\\[${esc(cap.appName || this.c.game.title)}\\]\\s*${esc(cap.windowTitle || this.c.game.title)}$`);
        const w = propertyItems.find(i => want.test(String(i.itemName).trim()));
        if (!w) return null;
        await this.call('SetInputSettings', { inputName, inputSettings: { window: w.itemValue }, overlay: true });
        return w.itemName;
    }
    profileFor(target) {
        if (!['youtube', 'twitch', 'simulcast'].includes(target)) throw new Error('配信先を選択してください。');
        return target === 'simulcast' ? this.c.obsSimulcastProfile : target === 'twitch' ? this.c.obsTwitchProfile : this.c.obsYouTubeProfile;
    }
    async destination(target = this.c.streamTarget) {
        const p = await this.call('GetProfileList');
        const r = await this.call('GetStreamServiceSettings');
        const service = r.streamServiceSettings?.service || '';
        const actual = /^YouTube(?: - |$)/i.test(service) ? 'youtube' : service === 'Twitch' ? 'twitch' : /^Restream(?:[ .-]|$)/i.test(service) ? 'simulcast' : 'other';
        const profile = p.currentProfileName;
        const ready = !!target && actual === target && profile === this.profileFor(target) && !!r.streamServiceSettings?.key;
        return { selected: target || '', actual, service, profile, ready };
    }
    async assertDestination(target = this.c.streamTarget) {
        const d = await this.destination(target);
        if (!d.ready) throw new Error('選択した配信先とOBS設定が一致しないか、配信キーが未設定です。停止して配信先を設定してください。');
        return d;
    }
    selectDestination(target, save = () => {}) {
        return this.serialize(async () => {
            const profileName = this.profileFor(target);
            const stream = await this.call('GetStreamStatus');
            const record = await this.call('GetRecordStatus');
            const replay = await this.call('GetReplayBufferStatus').catch(e => {
                if (e.message === 'OBS GetReplayBufferStatus failed (604)') return { outputActive: false }; // This request uses InvalidResourceState when replay is unavailable.
                throw e;
            });
            if (stream.outputActive || stream.outputReconnecting || record.outputActive || replay.outputActive) throw new Error('配信・録画・リプレイバッファを停止してから切り替えてください。');
            const p = await this.call('GetProfileList');
            if (!p.profiles.includes(profileName)) throw new Error(`OBSに「${profileName}」プロフィールがありません。`);
            try {
                if (p.currentProfileName !== profileName) await this.call('SetCurrentProfile', { profileName });
                const result = await this.assertDestination(target);
                await save(target);
                return result;
            } catch (error) {
                if (p.currentProfileName !== profileName) await this.call('SetCurrentProfile', { profileName: p.currentProfileName }).catch(() => {});
                throw error;
            }
        });
    }
    start() {
        return this.serialize(async () => {
            if (!this.c.allowStream || this.c.mode !== 'live')
                throw new Error('OBS output is disabled');
            const status = await this.call('GetStreamStatus');
            if (status.outputActive || status.outputReconnecting)
                throw new Error('OBS is already streaming; refusing to take ownership');
            // Unknown is not stopped: never take ownership of an output whose state OBS did not report.
            if (status.outputActive !== false)
                throw new Error('OBS did not report its stream state; refusing to take ownership');
            if (this.c.streamTarget) await this.assertDestination();
            // Persist intent before sending StartStream: a lost acknowledgement must not leave an unowned stream.
            writeFileSync(`${this.c.dataDir}/obs-owned.json`, JSON.stringify({ at: new Date().toISOString(), input: this.c.obsInput, pid: process.pid }), { mode: 0o600 });
            this.owned = true;
            try {
                await this.call('StartStream');
            }
            catch (e) {
                await this.stopOwnedImpl().catch(() => { });
                throw e;
            }
            await this.startRecording();
        });
    }
    /** The operator confirms that the live output is this Studio's own (after a hot restart of the Studio while OBS kept
     * streaming): take ownership so a completed show shows 配信終了 and stops it. Only an active output can be adopted. */
    adopt() {
        return this.serialize(async () => {
            if (this.owned) return true;
            const status = await this.call('GetStreamStatus');
            if (status.outputActive !== true) throw new Error('OBS is not streaming; nothing to adopt');
            writeFileSync(`${this.c.dataDir}/obs-owned.json`, JSON.stringify({ at: new Date().toISOString(), input: this.c.obsInput, pid: process.pid, adopted: true }), { mode: 0o600 });
            this.owned = true;
            await this.startRecording();
            return true;
        });
    }
    /** OBS_RECORD=true: the broadcast is also recorded locally (OBS's own recording settings), from the Studio's stream
     * start or adoption until its stop. A recording failure never touches the stream. -> whether OBS records. */
    async startRecording() {
        if (!this.c.obsRecord) return false;
        try {
            const r = await this.call('GetRecordStatus');
            if (r.outputActive !== true) await this.call('StartRecord');
            return true;
        } catch { return false; }
    }
    /** Disk low (src/disk-guard.mjs): the local recording stops, the stream goes on. -> whether it was recording. */
    async stopRecording() {
        try { const r = await this.call('GetRecordStatus'); if (r.outputActive !== true) return false; await this.call('StopRecord'); return true; }
        catch { return false; }
    }
    /** OBS's recording folder, or '' when OBS cannot say. */
    async recordDirectory() {
        try { return (await this.call('GetRecordDirectory')).recordDirectory || ''; } catch { return ''; }
    }
    /** Put a standby screen (SCREENS) on air, or 'show' for the programme scene. -> the scene name. */
    showScreen(name) {
        return this.serialize(async () => {
            const sceneName = name === 'show' ? this.programmeScene || this.c.obsScene : SCREENS[name];
            if (!sceneName) throw new Error('Unknown screen');
            await this.call('SetCurrentProgramScene', { sceneName });
            // A still screen (standby, away, ended) hides the stage browser source, so OBS drops its renderer: the
            // supervisor must not read that as a dead audio path (live 2026-10-11 19:59: the standby screen stopped the stream).
            this.screen = name;
            return sceneName;
        });
    }
    stop(force = false) { return this.serialize(() => this.stopOwnedImpl(force)); }
    stopOwned() { return this.serialize(() => this.stopOwnedImpl()); }
    async stopOwnedImpl(force = false) {
        if (!this.owned && !force)
            return;
        const status = await this.call('GetStreamStatus');
        if (status.outputActive)
            await this.call('StopStream');
        if (this.c.obsRecord) await this.call('GetRecordStatus').then(r => r.outputActive ? this.call('StopRecord') : null).catch(() => {});
        this.owned = false; this.screen = null;
        rmSync(`${this.c.dataDir}/obs-owned.json`, { force: true });
    }
    close() { this.ready = false; this.ws?.close(); }
}
