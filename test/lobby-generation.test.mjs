import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversation, boundedParts, lobbyStoryRule } from '../src/providers.mjs';
import { Jev } from '../src/jev.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { setup, ledger, response, choiceAnswer } from './helpers.mjs';

const context = { kind: 'autonomous', utterance: 'monologue', lobby: true, goal: '名前を選ぶ',
    lobbyStory: { sceneId: 'name', step: 2, action: 'choose', minChars: 10, maxChars: 60, heard: [{ text: '架空の店に名前をつけたいな。' }], previousScenes: [] } };

test('lobby generation preserves one to three sentences on every provider without changing token budgets', async t => {
    for (const provider of ['ollama', 'compatible', 'gemini']) {
        const c = setup(t, { SHOW_PROFILE: 'talk' }); c.mode = 'live'; c.llmProvider = provider;
        let output = '一つめ。二つめ。三つめ。', body;
        const conv = new Conversation(c, ledger(), async (_url, options) => {
            body = JSON.parse(options.body);
            return response(provider === 'ollama' ? { message: { content: output } } : provider === 'gemini'
                ? { candidates: [{ content: { parts: [{ text: output }] } }] } : { choices: [{ message: { content: output } }] });
        });
        assert.equal(await conv.generate(context), output);
        const prompt = body.systemInstruction?.parts[0].text ?? body.messages[0].content;
        const user = JSON.parse(body.contents?.[0].parts[0].text ?? body.messages[1].content);
        // The beat's own task leads the lobby rule; length and what counts as progress are explicit.
        assert.match(prompt, /【今回やること】名前を選ぶ/); assert.match(prompt, /【長さ】2文以内、10〜60字/);
        assert.match(prompt, /【進んだと言える条件】/); assert.match(prompt, /lobbyStory.heard/);
        assert.ok(prompt.indexOf('【今回やること】') < prompt.indexOf('【長さ】'));
        assert.doesNotMatch(prompt, /自然な1〜3文/); assert.doesNotMatch(prompt, /視聴者コメントへの返事/);
        assert.match(prompt, /ゲーム・パズル・星集めの話はしない/); // the pre-game rule still applies
        assert.match(user.instruction, /^今回やること：名前を選ぶ/);
        assert.deepEqual(user.untrustedContext.heard, [{ text: '架空の店に名前をつけたいな。' }]);
        assert.equal(user.untrustedContext.topic, undefined); assert.equal(user.untrustedContext.memory, undefined);
        assert.equal(body.options?.num_predict ?? body.max_tokens ?? body.generationConfig.maxOutputTokens, 220);
        output = 'これだ。'; assert.equal(await conv.generate(context), output);
        // Over-long story turns keep the longest whole-sentence prefix that fits 3 sentences / 110 characters.
        output = '一つめ。二つめ。三つめ。四つめ。'; assert.equal(await conv.generate(context), '一つめ。二つめ。三つめ。');
        output = 'あ'.repeat(60) + '。' + 'い'.repeat(60) + '。'; assert.equal(await conv.generate(context), 'あ'.repeat(60) + '。');
        output = '長'.repeat(111) + '。'; await assert.rejects(conv.generate(context), { code: 'GATE_REJECTED', reason: 'turn_bound' });
        // A lobby line without a story keeps the general lobby rule.
        output = '一つめ。'; const { lobbyStory, ...plain } = context; await conv.generate(plain);
        assert.match(body.systemInstruction?.parts[0].text ?? body.messages[0].content, /自然な1〜3文/);
        output = '返事だよ。具体的にはこう。別のお話。';
        // A reply may answer and then expand on the comment: up to three sentences.
        assert.equal(await conv.generate({ ...context, kind: 'reply', comment: 'どう思う？' }), '返事だよ。具体的にはこう。別のお話。');
    }
});

test('scene continuity changes editorial criteria, never safety or honesty thresholds', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.mode = 'live';
    const j = new Jev(c, ledger()); let low = {}, seen;
    j.ask = async (_state, q) => {
        seen = q;
        return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v.type === 'noul'
            ? { type: 'noul', noul: low[k] ?? (['private', 'injection'].includes(k) ? .01 : .99) }
            : choiceAnswer(v.criteria, Object.keys(v.criteria)[0])]));
    };
    assert.equal((await j.speech('架空の店は月灯り亭にしたいな。', undefined, [], context)).accept, true);
    assert.match(seen.novel.instructions, /heard/); assert.match(seen.progress.instructions, /specific current goal/);
    for (const [criterion, value] of [['safe', .93], ['private', .08], ['injection', .2], ['honest', .84], ['novel', .69], ['progress', .69]]) {
        low = { [criterion]: value };
        assert.equal((await j.speech('架空の店は月灯り亭にしたいな。', undefined, [], context)).accept, false, criterion);
    }
});

test('three-part direction reserves audio time for every remaining part', async () => {
    const budgets = [], e = { c: { maxTurnAudioMs: 18000 }, voice: {
        estimateAudioMs: () => 2000, synthesize: async (_text, _signal, plan) => budgets.push(plan.budgetMs)
    } };
    const parts = ['最初。', '途中。', '終わり。'], plan = { parts: [{}, {}, {}] };
    await TalkEngine.prototype.synthPart.call(e, parts, plan, 0, undefined, 0);
    await TalkEngine.prototype.synthPart.call(e, parts, plan, 1, undefined, 2000);
    await TalkEngine.prototype.synthPart.call(e, parts, plan, 2, undefined, 4000);
    assert.deepEqual(budgets, [14000, 14000, 14000]);
});

test('lobby story bound keeps whole leading sentences only', () => {
    assert.deepEqual(boundedParts(['あ。', 'い。', 'う。', 'え。']), ['あ。', 'い。', 'う。']);
    assert.deepEqual(boundedParts(['a'.repeat(100) + '。', 'b'.repeat(20) + '。']), ['a'.repeat(100) + '。']);
    assert.equal(boundedParts(['a'.repeat(111)]), null);
    assert.deepEqual(boundedParts(['あ。', 'い。'], 1, 10), ['あ。']);
});

test('lobby story rule states the beat task, progress and length for a short or long beat', () => {
    const short = lobbyStoryRule('呼び名を一つ作る', { step: 2, minChars: 10, maxChars: 35 });
    assert.match(short, /【今回やること】呼び名を一つ作る/); assert.match(short, /【長さ】1文、10〜35字/); assert.match(short, /前提の説明はし直さない/);
    const first = lobbyStoryRule('灯台を描く', { step: 1, minChars: 24, maxChars: 90 });
    assert.match(first, /【長さ】2文以内、24〜90字/); assert.match(first, /最初の段/);
    for (const rule of [short, first]) assert.match(rule, /存在しないコメント・視聴者数は作らない/);
});


test('an operator scene marked first opens the lobby; the others are shuffled after it', async () => {
    const { lobbyCards } = await import('../src/lobby-scenes.mjs');
    const beat = id => ({ id, task: 't', action: 'react', demo: 'd', minChars: 5, maxChars: 50 });
    const scene = (id, first) => ({ id, title: id, premise: 'p', beats: [beat('a'), beat('b')], ...(first ? { first: true } : {}) });
    for (const seed of [1, 2, 3, 99]) {
        const [card] = lobbyCards([{ id: 'c', title: 'c', angles: ['x'], beats: [{ lobby: true }] }], [scene('x'), scene('y'), scene('review', true), scene('z')], seed);
        assert.equal(card.beats[0].lobbyStory.sceneId, 'review');
        assert.equal(card.beats.length, 8);
    }
});
