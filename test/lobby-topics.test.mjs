import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFeed, suitable, topicScene, fetchTopics, saveTopicScenes } from '../src/lobby-topics.mjs';
import { lobbyCards } from '../src/lobby-scenes.mjs';
import { roomTopic } from '../public/stage-theme.mjs';

const rss = items => `<rss><channel>${items.map(t => `<item><title>${t}</title><link>https://news.example/${encodeURIComponent(t)}</link><pubDate>Thu, 15 Oct 2026 12:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
const builtin = JSON.parse(readFileSync(new URL('../config/lobby-scenes.json', import.meta.url), 'utf8')).scenes;

test('headlines are parsed as plain text and sad, political or personal-trouble ones are left out', () => {
    assert.deepEqual(parseFeed(rss(['新型スマホ &amp; 発表 https://x.example/a'])).map(i => i.title), ['新型スマホ & 発表']);
    assert.equal(suitable('新しいロケット打ち上げ成功'), true);
    for (const t of ['俳優が体調不良で活動休止', '首相が会見', '大雨で被害', '容疑者を逮捕', '元代表がイベで重傷', 'サービス一時停止を発表']) assert.equal(suitable(t), false, t);
});

test('each headline becomes a valid first lobby scene that only says what the headline says', () => {
    const scene = topicScene({ title: '新しいロケット打ち上げ成功', category: '科学' }, 1);
    assert.equal(scene.first, true); assert.match(scene.premise, /見出しにない/);
    assert.ok(lobbyCards([{ id: 'p', title: 'p', angles: ['p'], beats: [{ lobby: true }] }], [scene, ...builtin.slice(0, 3)]));
});

test('fetchTopics takes one suitable headline per feed in turn; a failing feed is skipped', async () => {
    const feeds = [{ category: 'IT', url: 'a' }, { category: '科学', url: 'b' }, { category: 'x', url: 'c' }];
    const body = { a: rss(['AI新機能が話題', '首相が発表', 'ゲーム新作発売']), b: rss(['新種の深海魚を発見']) };
    const topics = await fetchTopics(async url => { if (url === 'c') throw new Error('down'); return { ok: true, text: async () => body[url] }; }, { feeds, count: 3 });
    assert.deepEqual(topics.map(t => t.title), ['AI新機能が話題', '新種の深海魚を発見', 'ゲーム新作発売']);
});

test('saved topics open the lobby in order, the operator scenes follow unmarked, and a dated memo is kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'topics-'));
    const { scenes, memo } = saveTopicScenes(dir, builtin, [{ title: 'AI新機能が話題', category: 'IT', link: 'https://news.example/1', at: 'now' }], new Date('2026-10-16T01:00:00Z'));
    assert.equal(scenes[0].id, 'news-1'); assert.ok(scenes.slice(1).every(s => s.first === undefined));
    assert.equal(JSON.parse(readFileSync(join(dir, 'lobby-scenes.json'), 'utf8')).scenes[0].title, 'AI新機能が話題');
    assert.match(readFileSync(memo, 'utf8'), /AI新機能が話題/); assert.deepEqual(readdirSync(join(dir, 'topics')), ['2026-10-16.md']);
    const again = saveTopicScenes(dir, builtin, [{ title: '新種の深海魚を発見', category: '科学', link: '', at: '' }]);
    assert.deepEqual(again.scenes.filter(s => s.id.startsWith('news-')).map(s => s.title), ['新種の深海魚を発見']);
});

test('the theme box follows the opening-talk scene', () => {
    assert.deepEqual(roomTopic({ topic: { scene: 'AI新機能が話題', title: 'ノアの夜ふかしゲーム部' } }), { label: '今日のテーマ', text: 'AI新機能が話題' });
});
