// Fixed replies stay on the normal input/output safety and read-permission path.
// Match the WHOLE social reaction: a greeting followed by a question or advice
// must keep the normal reply path, even if the viewer omitted a question mark.
const ACKS = [
    ['first_visit', /^(?:(?:こんばんは|こんにちは|おはよう)[、\s]*)?(?:初見(?:です|だよ)?|はじめまして|初めまして)$/, ['はじめまして、ゆっくり見ていってね。']],
    ['greeting', /^(?:こんばんは|こんばんわ|こんにちは|こんにちわ|おはよ(?:う)?|やっほ[ー〜~]*|こん)(?:です)?$/, ['こんばんは！来てくれてありがとう、ゆっくりしていってね。']],
    ['compliment', /^(?:(?:{name}(?:ちゃん)?|声)(?:が|は)?)?(?:かわい[いー]+|可愛い|好き|癒される)(?:ね|よ|です)?$/, ['えへへ、ありがとう！ちょっと照れるな。', 'ありがとう、うれしい！照れちゃうね。']],
    ['thanks', /^(?:ありがと(?:う)?(?:ございます)?|ありがたい|感謝)$/, ['どういたしまして、こちらこそありがとう！']],
    ['otsukare', /^(?:おつ(?:かれ)?(?:さま|様)?(?:です)?|お疲れ(?:さま|様)?(?:です)?|乙)$/, ['ありがとう、来てくれてうれしいな！']],
    ['goodnight', /^(?:おやすみ(?:なさい)?|寝ます|ねます)$/, ['おやすみなさい、来てくれてありがとう！']],
    ['cheer', /^(?:がんば(?:れ|って(?:ね)?)?|頑張(?:れ|って(?:ね)?)?|ファイト|応援(?:してる|しています)?)(?:ね|よ)?$/, ['応援ありがとう！うれしいな。']],
    ['praise', /^(?:すご(?:い|すぎ)?|うま(?:い|すぎ)?|上手|つよ(?:い|すぎ)?|強い|ナイス|天才|いいね)(?:ね|よ|です)?$/, ['ありがとう、うれしい！']],
    ['laugh', /^(?:草+|[wｗ]{1,10}|笑+|笑った|草生える|大草原|うける|ウケる)$/, ['ふふ、笑ってくれてうれしい。', 'あはは、笑ってくれてありがとう！']],
    ['danger', /^(?:危な(?:い|っ)|あぶな(?:い|っ)|あぶね[ーえ])$/, ['ひやっとするね、教えてくれてありがとう。']],
    ['close_call', /^(?:惜しい|おしい|惜しかった|おしかった)$/, ['うう、くやしいね。']],
    ['surprise_react', /^(?:あ+|え+|えっ|えー+|うわ+|！？|\?!|[!?]{1,3})$/, ['びっくりしたよね！', 'わ、おどろいた！']],
    ['direction_right', /^(?:[Rr]|右|みぎ|右行け|右へ)$/, ['右だね、行ってみる！', '右へ向かってみるね。']],
    ['direction_left', /^(?:[Ll]|左|ひだり|左行け|左へ)$/, ['左だね、行ってみる！', '左へ向かってみるね。']],
    ['direction_up', /^(?:[Uu]|上|うえ|上行け|上へ)$/, ['上だね、上へ行ってみる！', '上を目指してみるね。']],
    ['direction_down', /^(?:[Dd]|下|した|下行け|下へ)$/, ['下だね、下へ行ってみる！', '下へ向かってみるね。']],
    ['choice_a', /^(?:[Aa]|1|1番|１)$/, ['Aね、やってみる！', '1番目だね、了解！']],
    ['choice_b', /^(?:[Bb]|2|2番|２)$/, ['Bね、やってみる！', '2番目だね、了解！']],
    ['agree', /^(?:[○oO]|マル|まる|丸|はい|うん|うむ|合ってる|ok|OK|おk)$/i, ['賛成してくれてありがとう！', 'よし、合ってた！よかった。']],
    ['disagree', /^(?:[×xX]|バツ|ばつ|いいえ|いや|ダメ|だめ|違う|ちがう|no|NO)$/i, ['反対されちゃった、気をつけるね。', 'だめだったか、慎重にいこう。']],
    ['tease', /^(?:下手(?:くそ|っぴ)?|へた(?:くそ|っぴ)?|下手w|へたw)$/, ['むっ、今のは事故だから！次見てて！', '下手じゃないもん、手が滑っただけ！']],
    ['hopeless', /^(?:無理(?:ゲー|だ)?|むり|絶対負ける|負けそう|あーあ|オワタ|おわた)(?:[wｗ]+)?$/, ['まだ諦めないよ！ここから見てて！', '無理じゃない！ここから巻き返すよ！']],
    ['comfort', /^(?:どんまい|ドンマイ|どんまい〜|ドンマイ〜|ドンマイドンマイ)$/, ['ありがとう、次こそ頑張るね！', 'やさしい！次は持ち直してみせるね。']],
];
// A single emoji may contain a variation selector, skin tone or a ZWJ sequence.
// Do not guess the viewer's emotions, identity or what happened in the game.
const ONE_EMOJI = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)$/u;
const TECHNICAL_ACKS = [
    ['audio_feedback', /^(?:声|音|音声|音量)(?:が|は)?(?:小さい|大きい|聞こえない|聞きづらい)(?:です|ね|よ|気がする|ようです)?$/, '教えてくれてありがとう。こちらでは聞こえ方を確認できないんだ。'],
];
/** The host's own name is part of the compliment pattern (config/character.json name; default ノア). */
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const acksFor = name => ACKS.map(([kind, re, lines]) => [kind, re.source.includes('{name}') ? new RegExp(re.source.replace('{name}', escapeRe(name)), re.flags) : re, lines]);
const ackCache = new Map();
export function commentAck(text = '', turn = 0, name = 'ノア') {
    if (!ackCache.has(name)) ackCache.set(name, acksFor(name));
    const acks = ackCache.get(name);
    const t = String(text).normalize('NFKC').trim();
    if (!t || t.length > 60) return null;
    // These exact, single-intent checks describe only capabilities we actually have.
    // Still judged by Jev before speaking; appended requests must use the full reply path.
    const technical = TECHNICAL_ACKS.find(([, re]) => re.test(t.replace(/[!?。．.、,\s]+$/gu, '')));
    if (technical) return { kind: technical[0], template: technical[2] };
    if (/[?？]/.test(t)) return null;
    // Trailing emoji, kaomoji-like symbols and punctuation do not change a greeting (live 2026-10-09: 「こんばんは🐥」
    // went to a generated reply that ignored the greeting).
    const bare = t.replace(/(?:[!！。．.、,\s〜~♪☆★]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D)+$/gu, '') || t;
    const hit = acks.find(([, re]) => re.test(bare));
    if (hit) {
        const index = Number.isFinite(turn) ? Math.abs(Math.trunc(turn)) % hit[2].length : 0;
        return { kind: hit[0], template: hit[2][index] };
    }
    const scoreMatch = bare.match(/^([0-9]{1,3})点?$/);
    if (scoreMatch) {
        const val = Number(scoreMatch[1]);
        if (val === 100) return { kind: 'score_100', template: '100点満点！やったー！' };
        if (val >= 80 && val <= 99) return { kind: 'score_high', template: `${val}点！高得点ありがとう！` };
        if (val >= 50 && val <= 79) return { kind: 'score_mid', template: `${val}点！もっと上を目指すね。` };
        if (val > 0 && val < 50) return { kind: 'score_low', template: `${val}点！次はもっと頑張るね。` };
        if (val === 0) return { kind: 'score_zero', template: '0点！次は挽回してみせるね！' };
    }
    return ONE_EMOJI.test(bare) ? { kind: 'emoji', template: '絵文字ありがとう、受け取ったよ。' } : null;
}
