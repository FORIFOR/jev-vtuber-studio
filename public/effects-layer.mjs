// Draws Noa's effects (see effect-director.mjs) in one layer over the stage. Everything is placed around Noa's face,
// computed from the avatar box, so it follows her size and position and never covers her face, the subtitle or the
// board (the record confetti falls over the board's edge only). Each show replaces the previous lead effect and every
// element is removed after at most MAX_EFFECT_MS.
import { MAX_EFFECT_MS } from './effect-director.mjs';

const FACE = { x: 715 / 1200, y: 520 / 1600 }; // face centre in the Noa model's canvas (1200x1600)

export class EffectsLayer {
    constructor(root, { avatar, board = null, reducedMotion = false } = {}) {
        Object.assign(this, { root, avatar, board, reducedMotion });
        this.timers = []; this.nodes = [];
    }
    anchor() {
        const a = this.avatar(), w = a.offsetWidth || 700;
        return { x: a.offsetLeft + w * FACE.x, y: a.offsetTop + w * 4 / 3 * FACE.y, k: w / 700 };
    }
    add(cls, style, text = '') {
        const el = document.createElement('div');
        el.className = `fx ${cls}`; Object.assign(el.style, style); if (text) el.textContent = text;
        this.root.append(el); this.nodes.push(el); return el;
    }
    clear() { for (const t of this.timers) clearTimeout(t); this.timers = []; for (const n of this.nodes) n.remove(); this.nodes = []; }
    show(e) {
        this.clear();
        const { x, y, k } = this.anchor(), ms = Math.min(e.ms, MAX_EFFECT_MS), px = v => `${Math.round(v)}px`;
        this.root.style.setProperty('--fx-ms', `${ms}ms`);
        if (!this.reducedMotion) this.drawFx(e.fx, { x, y, k, px });
        if (e.telop && e.telopStyle) {
            // Right edge left of the face: the words sit beside her, not on her.
            this.add(`telop telop-${e.telopStyle}`, { right: px(this.root.offsetWidth - (x - 150 * k)), top: px(y - 170 * k), fontSize: px(TELOP_SIZE[e.telopStyle] * Math.max(.8, k)) }, e.telop);
        }
        this.timers.push(setTimeout(() => this.clear(), ms));
    }
    drawFx(fx, { x, y, k, px }) {
        if (fx === 'sparkle') for (let i = 0; i < 7; i++) {
            const a = -Math.PI * .95 + i * Math.PI * 1.9 / 6, r = 250 * k;
            this.add('sparkle', { left: px(x + Math.cos(a) * r * 1.05), top: px(y + Math.sin(a) * r * .95), animationDelay: `${i * 90}ms`, fontSize: px((i % 2 ? 26 : 38) * k) }, '✦');
        }
        else if (fx === 'speedlines') this.add('speedlines', { left: px(x - 520 * k), top: px(y - 520 * k), width: px(1040 * k), height: px(1040 * k) });
        else if (fx === 'warmglow') for (let i = 0; i < 5; i++) this.add('glow', { left: px(x + (i % 2 ? 1 : -1) * (130 + i * 22) * k), top: px(y + (40 - i * 18) * k), width: px((34 + i * 6) * k), height: px((34 + i * 6) * k), animationDelay: `${i * 140}ms` });
        else if (fx === 'sweat') {
            this.add('sweat', { left: px(x + 175 * k), top: px(y - 210 * k), width: px(26 * k), height: px(38 * k) });
            for (let i = 0; i < 3; i++) this.add('gloom', { left: px(x - (150 - i * 22) * k), top: px(y - 300 * k), height: px(46 * k), animationDelay: `${i * 80}ms` });
        }
        else if (fx === 'bounce') for (const side of [-1, 1]) this.add('bounce', { left: px(x + side * 230 * k - 20 * k), top: px(y - 60 * k), fontSize: px(40 * k) }, '〜');
        else if (fx === 'confetti' && this.board) {
            const b = this.board(); if (!b) return;
            this.add('board-glow', { left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h) });
            const colors = ['#ffe39a', '#8fd0ff', '#ff9ac0', '#9dffb0', '#c7a6ff'];
            for (let i = 0; i < 26; i++) this.add('confetti', { left: px(b.x + (i * 37 % b.w)), top: px(b.y - 10), background: colors[i % colors.length], animationDelay: `${(i * 53) % 700}ms`, '--fall': px(b.h * .55 + (i * 29 % 120)) });
        }
    }
    /** A brief frame flash on the board for a real multi-line clear (game-synced, not a lead effect). */
    flash() {
        const b = this.board?.(); if (!b || this.reducedMotion) return;
        const el = document.createElement('div'); el.className = 'fx board-flash';
        Object.assign(el.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
        this.root.append(el); setTimeout(() => el.remove(), 700);
    }
}
const TELOP_SIZE = { joy: 54, surprise: 60, shy: 38, trouble: 36, laugh: 44 };
