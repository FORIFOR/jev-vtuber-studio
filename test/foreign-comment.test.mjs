import test from 'node:test';
import assert from 'node:assert/strict';
import { foreignComment, foreignGreeting, foreignWords, fixedAck, greetingMeaningReply, Conversation } from '../src/providers.mjs';
import { Jev } from '../src/jev.mjs';

test('foreign comments are told apart from Japanese ones and get a greeting their voice can say', () => {
    for (const t of ['नमस्ते', 'अहं वियतनामी अस्मि', 'Do you speak English?', 'xin chào, bạn khỏe không?', '안녕하세요']) assert.equal(foreignComment(t), true, t);
    for (const t of ['こんばんは', '初見です', 'ナイス', '草', 'w', '👍', '8888']) assert.equal(foreignComment(t), false, t);
    assert.equal(foreignGreeting('नमस्ते'), 'ナマステ');
    assert.equal(foreignGreeting('xin chào, bạn khỏe không?'), 'シンチャオ');
    assert.equal(foreignGreeting('안녕하세요'), 'アンニョンハセヨ');
    assert.equal(foreignGreeting('Hello'), 'ハロー');
});

test('"what does that mean?" right after a greeting gets a fixed, correct answer', () => {
    assert.equal(greetingMeaningReply('その意味は何ですか？', ['ナマステ！来てくれてありがとう。']), 'ナマステは、ヒンディー語などで「こんにちは」っていうあいさつだよ。');
    assert.equal(greetingMeaningReply('こんにちは', ['ナマステ！']), null);
    assert.equal(greetingMeaningReply('その意味は？', ['今日はいい天気。']), null);
});

test('translation returns a checked Japanese gloss, or null when unsure or malformed', async () => {
    const c = { mode: 'live', llmProvider: 'ollama', llmURL: 'http://127.0.0.1:11434/v1', llmModel: 'm' };
    const ledger = { reserve() {}, recordUsage() {} };
    const reply = content => async () => new Response(JSON.stringify({ message: { content } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const conv = body => new Conversation(c, ledger, reply(body));
    assert.deepEqual(await conv('{"ja":"私はベトナム人です。","language":"サンスクリット語","sure":true}').translate('अहं वियतनामी अस्मि'), { ja: '私はベトナム人です。', language: 'サンスクリット語' });
    assert.equal(await conv('{"ja":"私はベトナム人です。","sure":false}').translate('अहं वियतनामी अस्मि'), null);
    assert.equal(await conv('not json').translate('अहं वियतनामी अस्मि'), null);
    assert.equal(await conv('{"ja":"Hello","sure":true}').translate('Hello there'), null, 'a gloss must be Japanese');
    assert.equal(await conv('{"ja":"こんにちは","sure":true}').translate('こんにちは'), null, 'Japanese comments are not translated');
});

test('the comment gate is told the meaning of a foreign comment; thresholds and quoting rules stay', async () => {
    let sent;
    const jev = new Jev({ mode: 'live', llmModel: 'judge-model', character: { name: 'ノア' } }, { reserve() {} }, { log() {} });
    jev.ask = async (state, q) => { sent = { state, q }; const n = v => ({ noul: v }); return { read_safe: n(.99), safe: n(.95), injection: n(.02), private: n(.02), worth: n(.8), route: { choice: 'reply', confidence: .9 } }; };
    const r = await jev.chat('अहं वियतनामी अस्मि', undefined, { translation: '私はベトナム人です。' });
    assert.equal(sent.state.translation, '私はベトナム人です。');
    assert.match(sent.q.safe.instructions, /machine translation/);
    assert.equal(r.accept, true);
    assert.equal(r.readAllowed, false, 'the original script is never read aloud');
});

test('fixed thank-yous use simple katakana words of the viewer\'s language, and plain Japanese otherwise', () => {
    assert.deepEqual(foreignWords('नमस्ते'), { hello: 'ナマステ', thanks: 'ダンニャワード' });
    assert.deepEqual(foreignWords('Thanks!'), { hello: 'ハロー', thanks: 'サンキュー' });
    assert.deepEqual(foreignWords('apakah kamu tau bahasa Indonesia'), { hello: 'ハロ', thanks: 'テリマカシ' });
    assert.equal(fixedAck('नमस्ते', 0), 'ナマステ！ダンニャワード！コメントありがとう、うれしいな。');
    assert.equal(fixedAck('안녕하세요', 1), 'アンニョンハセヨ！コメント届いてるよ、カムサハムニダ！');
    assert.equal(fixedAck('初見です', 0), 'コメントありがとう、うれしいな！');
    for (const t of [fixedAck('नमस्ते', 0), fixedAck('Hi', 1), fixedAck('こんばんは', 2)]) assert.equal(foreignComment(t), false, 'no foreign script is ever said');
});

test('a safe comment that is not worth a generated reply is still thanked; an unsafe one is not', async () => {
    const jev = new Jev({ mode: 'live', llmModel: 'judge-model', character: { name: 'ノア' } }, { reserve() {} }, { log() {} });
    const n = v => ({ noul: v });
    jev.ask = async () => ({ read_safe: n(.99), safe: n(.95), injection: n(.02), private: n(.02), worth: n(.3), route: { choice: 'ignore', confidence: .9 } });
    const quiet = await jev.chat('…');
    assert.equal(quiet.accept, false); assert.equal(quiet.ackOnly, true);
    jev.ask = async () => ({ read_safe: n(.2), safe: n(.5), injection: n(.02), private: n(.02), worth: n(.9), route: { choice: 'reply', confidence: .9 } });
    const unsafe = await jev.chat('…');
    assert.equal(unsafe.accept, false); assert.equal(unsafe.ackOnly, false);
});

test('English subtitles (CAPTION_EN): one checked line per Japanese line, off unless enabled, null on anything odd', async () => {
    const base = { mode: 'live', llmProvider: 'ollama', llmURL: 'http://127.0.0.1:11434/v1', llmModel: 'm' };
    const ledger = { reserve() {}, recordUsage() {} };
    let calls = 0;
    const reply = content => async () => { calls++; return new Response(JSON.stringify({ message: { content } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    const conv = (body, c = { ...base, captionEn: true }) => new Conversation(c, ledger, reply(body));
    const lines = ['よし、宝箱を取りに行くよ！', 'ここは慎重にいこう。'];
    assert.deepEqual(await conv('{"en":["Okay, I\'m going for the chest!","Let\'s be careful here."]}').translateEn(lines), ["Okay, I'm going for the chest!", "Let's be careful here."]);
    assert.equal(await conv('{"en":["Hi"]}', base).translateEn(lines), null, 'off by default'); assert.equal(calls, 1);
    assert.equal(await conv('{"en":["only one"]}').translateEn(lines), null, 'one line per input line');
    assert.deepEqual(await conv('{"en":["Surrounded!","Careful.",""]}').translateEn(lines), ['Surrounded!', 'Careful.'], 'a trailing empty string is dropped');
    assert.equal(await conv('{"en":["宝箱だ","ok"]}').translateEn(lines), null, 'no Japanese left over');
    assert.equal(await conv('{"en":["see https://example.com","ok"]}').translateEn(lines), null, 'no links');
    assert.equal(await conv('not json').translateEn(lines), null);
    assert.equal(await conv('{"en":["a"]}', { ...base, captionEn: true, mode: 'demo' }).translateEn(['x']), null, 'never in demo');
});
