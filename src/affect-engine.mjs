/**
 * AffectEngine - 時間蓄積型・多層感情エンジン (for 星藍ノア)
 * 
 * 思想・モデル:
 * - ALMA: Personality(性格) / Mood(気分) / Emotion(感情) / Impulse(反射) の時間スケール分離
 * - EMA / FAtiMA: イベントの認知評価 (Appraisal) からの感情変調
 * - PAD 感情空間 + 補助感情 (Frustration, Embarrassment, Tilt, etc.)
 * - 混合感情 (Blush = 照れ赤面 vs 怒り赤面) & ヒステリシス (チャタリング防止)
 */

const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));

// 各感情の基準値 (平常心)
export const DEFAULT_BASELINE = {
    // PAD (Pleasure-Arousal-Dominance)
    valence: 0.2,       // -1.0 (最悪) 〜 +1.0 (最高)
    arousal: 0.35,      // 0.0 (静か) 〜 1.0 (興奮)
    dominance: 0.1,     // -1.0 (圧倒される) 〜 +1.0 (自信満々)

    // 補助感情 (0.0 〜 1.0)
    joy: 0.35,          // 喜び・楽しさ
    anger: 0.0,         // 怒り
    sadness: 0.0,       // 悲しみ・落胆
    surprise: 0.0,      // 驚き
    frustration: 0.0,   // イライラ・もどかしさ
    embarrassment: 0.0, // 照れ・恥ずかしさ
    excitement: 0.25,   // ワクワク
    confidence: 0.45,   // 自信・手応え

    // 配信・ゲーム固有
    tilt: 0.0,          // ゲーマーの温まり・フラストレーション蓄積
    engagement: 0.5,    // コメント・配信への熱中
};

// 感情の減衰時定数 tau (ミリ秒)
const TAU = {
    // Impulse (急激・一瞬): 2.5秒
    surprise: 2500,
    anger: 12000,

    // Emotion (標準的な感情): 20〜30秒
    joy: 25000,
    sadness: 25000,
    frustration: 25000,
    embarrassment: 20000,

    // Mood / Persistent (持続・気分): 60〜180秒
    valence: 90000,
    arousal: 60000,
    dominance: 90000,
    excitement: 60000,
    confidence: 90000,
    engagement: 60000,
    tilt: 180000,       // ゲーマーの温まりは3分かけてゆっくり冷める
};

export class AffectEngine {
    constructor(base = {}, now = Date.now()) {
        this.base = { ...DEFAULT_BASELINE, ...base };
        this.state = { ...this.base };
        this.at = now;

        // ヒステリシス状態追跡
        this.rageActive = false;
        this.rageEnteredAt = 0;
        this.rageExitedAt = 0;
    }

    /** 時間経過による指数減衰 */
    _updateHysteresis(now) {
        const isAngry = this.state.frustration > 0.70 || this.state.anger > 0.65;
        const isCalmed = this.state.frustration < 0.40 && this.state.anger < 0.35;

        if (!this.rageActive) {
            if (isAngry) {
                if (!this.rageEnteredAt) this.rageEnteredAt = now;
                if (now - this.rageEnteredAt >= 800) { // 0.8秒継続で確定
                    this.rageActive = true;
                    this.rageEnteredAt = 0;
                }
            } else {
                this.rageEnteredAt = 0;
            }
        } else {
            if (isCalmed) {
                if (!this.rageExitedAt) this.rageExitedAt = now;
                if (now - this.rageExitedAt >= 3500) { // 3.5秒継続で解除
                    this.rageActive = false;
                    this.rageExitedAt = 0;
                }
            } else {
                this.rageExitedAt = 0;
            }
        }
    }

    /** 時間経過による指数減衰 */
    decay(now = Date.now()) {
        const dt = Math.max(0, now - this.at);
        if (dt > 0) {
            for (const [key, baseVal] of Object.entries(this.base)) {
                const tau = TAU[key] || 25000;
                const k = Math.exp(-dt / tau);
                this.state[key] = baseVal + (this.state[key] - baseVal) * k;
            }
            this.at = now;
        }
        this._updateHysteresis(now);
        return this;
    }

    /** 感情デルタを加算 */
    delta(deltas = {}, now = Date.now()) {
        this.decay(now);
        for (const [k, d] of Object.entries(deltas)) {
            if (typeof this.state[k] === 'number') {
                const min = (k === 'valence' || k === 'dominance') ? -1.0 : 0.0;
                this.state[k] = clamp(this.state[k] + d, min, 1.0);
            }
        }
        this._updateHysteresis(now);
        return this;
    }

    /**
     * ゲームイベントの認知評価 (Appraisal)
     */
    appraiseGameEvent(eventType, facts = {}, now = Date.now()) {
        const d = {};
        switch (eventType) {
            case 'game_over':
                d.valence = -0.35;
                d.frustration = 0.35;
                d.sadness = 0.25;
                d.tilt = 0.30;
                d.dominance = -0.20;
                d.arousal = 0.20;
                // 連続ゲームオーバー時はさらに温まる
                if (facts.isStreak) {
                    d.frustration += 0.25;
                    d.tilt += 0.35;
                    d.embarrassment = 0.30;
                }
                break;

            case 'hp_low':
                d.arousal = 0.35;
                d.frustration = 0.20;
                d.dominance = -0.20;
                d.surprise = 0.15;
                break;

            case 'hp_recovered':
                d.valence = 0.25;
                d.frustration = -0.20;
                d.arousal = -0.10;
                d.joy = 0.20;
                break;

            case 'level_up':
                d.valence = 0.15;
                d.joy = 0.20;
                d.confidence = 0.15;
                d.engagement = 0.10;
                break;

            case 'weapon_new':
            case 'chest':
                d.valence = 0.30;
                d.joy = 0.35;
                d.excitement = 0.40;
                d.arousal = 0.25;
                d.confidence = 0.20;
                break;

            case 'horde': // 敵の大群
                d.arousal = 0.40;
                d.excitement = 0.25;
                d.surprise = 0.20;
                break;

            case 'surrounded': // 敵に囲まれた
                d.frustration = 0.15;
                d.arousal = 0.30;
                d.dominance = -0.10;
                break;

            case 'escaped': // 囲みから抜けた
                d.valence = 0.20;
                d.frustration = -0.15;
                d.confidence = 0.10;
                break;

            case 'boss': // 大きなボス
                d.arousal = 0.35;
                d.surprise = 0.30;
                d.excitement = 0.20;
                break;

            case 'fast_enemy': // 奇襲・高速の敵
                d.surprise = 0.50;
                d.arousal = 0.35;
                break;

            case 'boss_defeated':
            case 'turnaround': // 逆転・好成績
                d.valence = 0.60;
                d.joy = 0.65;
                d.excitement = 0.50;
                d.confidence = 0.45;
                d.dominance = 0.40;
                d.tilt = -0.40; // 勝利で温まりが一気に解消
                d.frustration = -0.50;
                break;

            default:
                break;
        }
        return this.delta(d, now);
    }

    /**
     * 視聴者コメントの認知評価 (Appraisal)
     */
    appraiseComment(text = '', sentiment = 'neutral', now = Date.now()) {
        const d = { engagement: 0.15 };

        // 簡易感情分析（正規表現）
        const isCompliment = /(うまい|上手|ナイス|流石|さすが|すごい|プロ|天才|かわいい|可愛い|神)/.test(text);
        const isTaunt = /(下手|へた|草|ワロタ|また死|あーあ|何してん|ポンコツ)/.test(text);
        const isCheer = /(がんばれ|頑張れ|ファイト|いける|落ち着いて)/.test(text);

        if (isCompliment) {
            d.valence = 0.30;
            d.joy = 0.30;
            d.confidence = 0.25;
            d.embarrassment = 0.30; // 褒められて照れる
        } else if (isTaunt) {
            d.frustration = 0.20;
            d.embarrassment = 0.35; // 恥ずかしさ＆悔しさ
            d.tilt = 0.15;
            d.dominance = -0.10;
        } else if (isCheer) {
            d.valence = 0.20;
            d.confidence = 0.20;
            d.joy = 0.15;
        }

        return this.delta(d, now);
    }

    /**
     * 混合感情の計算
     */
    derived() {
        const s = this.state;
        // 赤面: 照れ (0.55) + 興奮 (0.25) + イライラ (0.20)
        const blush = clamp(0.55 * s.embarrassment + 0.25 * s.arousal + 0.20 * s.frustration);
        // ドヤ度: 自信 + 主導権 + 喜び
        const smug = clamp(0.5 * s.confidence + 0.3 * Math.max(0, s.dominance) + 0.2 * s.joy);
        // 温まり度合い
        const tiltTotal = clamp(0.6 * s.tilt + 0.4 * s.frustration);

        return {
            blush,
            smug,
            tiltTotal,
            rageActive: this.rageActive,
            isTeasing: s.embarrassment > 0.45 && s.frustration < 0.30, // 純粋な照れ
            isRageBlush: blush > 0.50 && s.frustration > 0.50,         // キレ赤面
        };
    }

    /**
     * 既存の Affect (happy / energy / focus) との互換性を含むスナップショット
     */
    snapshot(now = Date.now()) {
        this.decay(now);
        const s = this.state, d = this.derived();
        return {
            // 既存 rig / UI 互換キー
            happy: Math.round(clamp((s.valence + 1) / 2 * 0.7 + s.joy * 0.3) * 100) / 100,
            energy: Math.round(clamp(0.1 + s.arousal * 0.55 + s.excitement * 0.35) * 100) / 100,
            focus: Math.round(clamp(s.engagement * 0.7 + s.confidence * 0.3) * 100) / 100,

            // PAD
            valence: Math.round(s.valence * 100) / 100,
            arousal: Math.round(s.arousal * 100) / 100,
            dominance: Math.round(s.dominance * 100) / 100,

            // 主要感情
            joy: Math.round(s.joy * 100) / 100,
            frustration: Math.round(s.frustration * 100) / 100,
            embarrassment: Math.round(s.embarrassment * 100) / 100,
            tilt: Math.round(s.tilt * 100) / 100,
            blush: Math.round(d.blush * 100) / 100,
            confidence: Math.round(s.confidence * 100) / 100,
            excitement: Math.round(s.excitement * 100) / 100,
            rageActive: d.rageActive,
        };
    }

    /**
     * LLM (発話生成プロンプト) に注入する感情指示ルールを生成
     */
    speechStyle(now = Date.now()) {
        this.decay(now);
        const s = this.state, d = this.derived();
        const lines = [];

        // 感情サマリー
        lines.push(`【現在のノアの感情・心理状態】`);
        lines.push(`- 気分: ${s.valence > 0.4 ? '上機嫌・好調' : s.valence < -0.2 ? '不調・悔しい' : '普通'}`);
        lines.push(`- イライラ/温まり(frustration/tilt): ${s.frustration.toFixed(2)} / ${s.tilt.toFixed(2)}`);
        lines.push(`- 照れ・恥ずかしさ(embarrassment): ${s.embarrassment.toFixed(2)} (赤面度: ${d.blush.toFixed(2)})`);
        lines.push(`- 自信(confidence): ${s.confidence.toFixed(2)}`);

        // スタイル指示
        lines.push(`【発話トーンへの反映ルール】`);
        if (d.rageActive || s.frustration > 0.65) {
            lines.push(`・かなり悔しく温まっている状態。短文（短い文）で、感嘆詞や言い直しを交える（例: 「いや待って待って！」「今のは無理でしょ！」）。`);
            lines.push(`・怒りの対象はゲームの理不尽さや自分のミスに向ける。視聴者への攻撃や暴言は絶対にしない。`);
        } else if (s.frustration > 0.35) {
            lines.push(`・少し悔しがり、焦りを滲ませる（例: 「ん？ 今の当たったの？」「あーもう、ちょっと落ち着こ」）。`);
        } else if (d.isTeasing) {
            lines.push(`・照れ隠しや強がりが少し混ざる（例: 「ま、まあ今のはたまたまだし！」「べ、別に褒められても嬉しくないからね」）。`);
        } else if (d.smug > 0.65) {
            lines.push(`・ドヤ感・自信たっぷり。テンポよく上機嫌に話す（例: 「見た？ 今の完璧だったでしょ！」「今日の私、冴えてるかも！」）。`);
        } else if (s.sadness > 0.4) {
            lines.push(`・しょんぼりして言葉少なめに悔しがる（例: 「うう……あと少しだったのに……」）。`);
        } else {
            lines.push(`・自然で親しみやすい配信者トーン。普段通りの語り口で話す。`);
        }

        return lines.join('\n');
    }

    /** 固定セリフの選び分け: 'frustrated'（イライラ > 0.35）か 'rage'（> 0.65 または rageActive）か null。 */
    tone(now = Date.now()) {
        this.decay(now);
        const f = this.state.frustration;
        return this.rageActive || f > 0.65 ? 'rage' : f > 0.35 ? 'frustrated' : null;
    }

    /** 従来の apply() との互換性 (プリセット適用) */
    apply(name, now = Date.now(), scale = 1) {
        const PRESETS = {
            happy: { joy: 0.25, valence: 0.20, excitement: 0.15 },
            excited: { excitement: 0.35, arousal: 0.30, joy: 0.20 },
            surprised: { surprise: 0.40, arousal: 0.35, excitement: 0.20 },
            shock: { surprise: 0.50, frustration: 0.20, arousal: 0.30 },
            troubled: { frustration: 0.25, sadness: 0.20, dominance: -0.15 },
            embarrassed: { embarrassment: 0.40, arousal: 0.20 },
            thinking: { engagement: 0.20, arousal: -0.10 },
            nod: { confidence: 0.15, engagement: 0.10 },
            neutral: {}
        };
        const p = PRESETS[name] || {};
        const scaled = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v * scale]));
        this.delta(scaled, now);
        return this.snapshot(now);
    }
}
