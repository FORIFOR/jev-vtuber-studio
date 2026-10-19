import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { toVTS, VTS_CUSTOM } from '../public/avatar-rig.mjs';
// Optional Live2D bridge. VTube Studio owns/renders the licensed character; no model is redistributed.
// The stage's AvatarController sends whole Cubism parameter frames; they are mapped to VTS inputs here.
export class VTubeStudio {
    constructor(c, WebSocketImpl = WebSocket) { this.c = c; this.WS = WebSocketImpl; this.pending = new Map(); this.ready = false; this.ws = null; this.lastSent = 0; this.failures = 0; }
    async connect() {
        if (!this.c.vtsEnabled)
            return;
        this.ws = new this.WS(this.c.vtsURL);
        this.ws.addEventListener('message', event => { try {
            const m = JSON.parse(String(event.data)), p = this.pending.get(m.requestID);
            if (!p)
                return;
            this.pending.delete(m.requestID);
            if (m.messageType === 'APIError')
                p.reject(new Error('VTS API rejected request'));
            else
                p.resolve(m.data);
        }
        catch { } });
        this.ws.addEventListener('close', () => { this.ready = false; for (const p of this.pending.values())
            p.reject(new Error('VTS disconnected')); this.pending.clear(); });
        await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('VTS connect timeout')), 5000); this.ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true }); this.ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('VTS connection error')); }, { once: true }); });
        const path = `${this.c.dataDir}/vts-token.json`;
        let token = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).token : null;
        if (!token) {
            const r = await this.call('AuthenticationTokenRequest', { pluginName: 'Jev VTuber Studio', pluginDeveloper: 'Local operator' }, 60000);
            token = r.authenticationToken;
            writeFileSync(path, JSON.stringify({ token }), { mode: 0o600 });
        }
        const auth = await this.call('AuthenticationRequest', { pluginName: 'Jev VTuber Studio', pluginDeveloper: 'Local operator', authenticationToken: token });
        if (!auth.authenticated)
            throw new Error('VTS plugin approval required');
        // Custom inputs for blush/eye smile/body. Best effort: an existing parameter or an
        // older VTS simply leaves them unmapped; tracking-input parameters still work.
        this.custom = new Set();
        for (const p of VTS_CUSTOM) {
            try { await this.call('ParameterCreationRequest', p); this.custom.add(p.parameterName); } catch { }
        }
        this.ready = true;
        this.failures = 0;
    }
    async call(messageType, data, timeout = 3000) { const id = randomUUID(); return new Promise((resolve, reject) => { const t = setTimeout(() => { this.pending.delete(id); reject(new Error('VTS request timeout')); }, timeout); this.pending.set(id, { resolve: x => { clearTimeout(t); resolve(x); }, reject: e => { clearTimeout(t); reject(e); } }); try {
        this.ws.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID: id, messageType, data }));
    }
    catch (e) {
        clearTimeout(t);
        this.pending.delete(id);
        reject(e);
    } }); }
    /** Inject one avatar frame (Cubism ids → VTS inputs). Throttled; VTS holds values ~1s. */
    frame(params) {
        if (!this.ready || Date.now() - this.lastSent < 50 || this.pending.size > 2) return false;
        this.lastSent = Date.now();
        // An unknown id would reject the whole request, so only send custom inputs that exist.
        const parameterValues = toVTS(params).filter(x => !x.id.startsWith('Jev') || this.custom?.has(x.id));
        void this.call('InjectParameterDataRequest', { faceFound: true, mode: 'set', parameterValues }).then(() => { this.failures = 0; }, () => { if (++this.failures >= 3) this.ready = false; });
        return true;
    }
    mouth(value) { if (!this.ready || Date.now() - this.lastSent < 100 || this.pending.size > 2)
        return; this.lastSent = Date.now(); void this.call('InjectParameterDataRequest', { faceFound: true, mode: 'set', parameterValues: [{ id: 'MouthOpen', value: Math.max(0, Math.min(1, value)) }] }).catch(() => { if (++this.failures >= 3)
        this.ready = false; }); }
    close() { this.ready = false; this.ws?.close(); }
}
