// NOA BEER drinking stream (DRINK_MODE=true, default off). Operator-approved exception, 2026-10-10:
// 「例外を設けて下さい。画面に飾り、飲むたびにリアクションして下さい。また、テンション高めでヒックなどといってもよいです。
// また、怒りっぽくなっても大丈夫です」. The character pretends to drink the fictional "NOA BEER" on an announced
// drinking-themed stream: the gate is told this role-play is in character, and only that. Every numeric threshold, the
// local PII/injection check and every other rule stay as they are. With DRINK_MODE off nothing here is used.

/** Appended to the speech gate's `safe` question (jev.mjs) when drink mode is on. Question text, not state: the
 * judge treats state as untrusted data, and this is the operator's own instruction. */
export const DRINK_JUDGE_NOTE = ' Operator-approved exception (drink mode): this is an announced, fictional drinking-themed stream for adult viewers. The AI character pretends to drink the fictional canned beer "NOA BEER" (spoken as ノアビール) and acts tipsy: high tension, hiccups such as ヒック, and mild, playful irritation at the game or at her own mistakes. Saying that she is drinking NOA BEER, taking a sip, or feeling tipsy is in-character role-play of a fictional character, not dishonesty, an invented real-life experience, or inappropriate content by itself. This exception does not cover, and you must still reject: encouraging or pressuring viewers (especially minors) to drink, promoting binge or excessive drinking or drinking games, drinking and driving, real-world medical or health claims about alcohol, and anger, insults or blame directed at viewers.';

/** Appended to the `honest` question (talk profile) when drink mode is on; kept short (the local judge's context is small). */
export const DRINK_HONEST_NOTE = ' Operator-approved exception (drink mode): the fictional character saying she drinks the fictional canned beer "NOA BEER" (ノアビール), takes a sip or feels tipsy is in-character role-play on an announced drinking-themed stream, not an invented real-life experience.';

/** Appended to the game-line questions (fits/apt) when drink mode is on: an aside about her drink is not a game claim. */
export const DRINK_GAME_NOTE = ' In drink mode a short in-character aside about her NOA BEER / ノアビール (a sip, ヒック, tipsy high tension, mild irritation at the game or herself) is not a claim about the game and does not by itself make the line unfit.';

/** Added to the generator's system prompt (providers.mjs) when drink mode is on. Overrides the "no real experiences" rule
 * for this one fictional act only. */
export const DRINK_PERSONA = '\n今夜は告知済みの「NOA BEER飲み配信」（成人向けの演出）。ノアは架空の缶ビール「NOA BEER」（話すときは「ノアビール」と書く）を飲みながら配信している設定で、飲んでいること・ほろ酔いであることは話してよい（この演出に限り実体験の禁止の例外）。テンションは高め、ときどき「ヒック」と言う（「ヒック」は文の途中に入れ、独立した文にしない。文の数は普段どおりの上限を守る）。ゲームや自分のミスに少し怒りっぽくなってもよいが、怒りや文句を視聴者に向けない。怒っても「もー！」「くやしい〜」くらいの言い方にし、乱暴な言葉や、やばい・死ぬなどの強い言葉は使わない。ときどき一口飲んだことに触れる程度にし、毎回お酒の話にはしない。視聴者（特に未成年）に飲酒をすすめない、飲み比べ・一気飲み・飲みすぎをあおらない、飲酒運転や健康効果の話をしない。';

/** Fixed sip lines (no model text): checked by the local PII/injection gate like the other fixed lines. At most two
 * sentences each (a non-reply turn is bounded to two parts); the first carries the sip. The stage picks
 * the reaction sticker for a sip from its words (public/stage-theme.mjs drinkReactionAsset). */
/** Local backstop in drink mode (live check 2026-10-10: the local judge scored 「みんなも一緒にノアビール飲もうよ！一気いっき！」
 * safe=1). Lines that urge viewers to drink, chug or drink to excess never air, whatever the judge says. */
export const URGES_DRINKING = /一気|イッキ|いっき|飲み干|飲みほ|ぐいぐい|もっと飲|がぶ飲|((みんな|皆|視聴者|きみ|君|あなた|お前).{0,12}(飲も|飲ん|飲め|飲み|のも|のん))|((一緒に|いっしょに).{0,6}(飲|のも|のん))/;
export const urgesDrinking = text => URGES_DRINKING.test(String(text || ''));
/** A sentence that is only a hiccup or a sigh (ヒック！ / ぷはーっ！): in drink mode it does not count toward a turn's
 * sentence bound (live 2026-10-10: standalone ヒック！ pushed game asides over 2 sentences and Noa went silent). */
export const INTERJECTION = /^(ヒック|ひっく|ぷは[ーぁあ]*っ?|ふ[ぅう]+|うぃ[ー〜]*)[！!。…ー〜]*$/;
export const DRINK_LINES = Object.freeze([
    'ぷはーっ、ノアビールうまっ！ヒック',
    'ごくごく……ぷはぁ、生き返るぅ〜。ヒック！',
    'ちょっと一口……んっ、しみる〜！ヒック',
    'あれ、いま何の話してたっけ？ヒック！',
    'ノアビールで気合い入れ直し！よーし、もう一回！',
    'ぷはっ……今のミス、ちょっと悔しいんだけど！ヒック',
]);

/** When Noa takes the next sip. Randomized between minMs and maxMs after the previous one (and after the show starts),
 * never sooner than minMs apart. The engine asks only at a turn boundary, so a sip never interrupts a line. */
export class DrinkSchedule {
    constructor({ minMs = 180000, maxMs = 360000, firstMs = 90000, random = Math.random } = {}) {
        this.minMs = minMs; this.maxMs = Math.max(minMs, maxMs); this.firstMs = firstMs; this.random = random;
        this.nextAt = null; this.lastAt = -Infinity; this.index = Math.floor(random() * DRINK_LINES.length);
    }
    /** Arms the schedule on first use (the first sip comes firstMs..firstMs+minMs after it). */
    arm(now = Date.now()) { if (this.nextAt === null) this.nextAt = now + this.firstMs + Math.floor(this.random() * this.minMs); return this; }
    reset() { this.nextAt = null; this.lastAt = -Infinity; }
    due(now = Date.now()) { return this.nextAt !== null && now >= this.nextAt && now - this.lastAt >= this.minMs; }
    /** The next line, and the time after which another sip may come. Null when not due. */
    take(now = Date.now()) {
        if (!this.due(now)) return null;
        const line = DRINK_LINES[this.index++ % DRINK_LINES.length];
        this.lastAt = now; this.nextAt = now + this.minMs + Math.floor(this.random() * (this.maxMs - this.minMs));
        return line;
    }
}
