// Fresh opening-talk topics (operator 2026-10-16: the opening talk had the same themes every stream). Before a show the
// day's Yahoo! News topic headlines (IT, science, entertainment, sports; RSS, no key) are fetched, sad, political or
// personal-trouble headlines are left out, and the rest become dated lobby scenes that open the talk; the stage's theme
// box follows each scene (Director.snapshot().scene). A memo of what was picked is kept under data/topics/. Headlines
// are untrusted text: they only reach the model as a premise, every line still passes the Jev gate, and a scene only
// says what its headline says.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lobbyCards } from './lobby-scenes.mjs';

export const TOPIC_FEEDS = [
    { category: 'IT', url: 'https://news.yahoo.co.jp/rss/topics/it.xml' },
    { category: '科学', url: 'https://news.yahoo.co.jp/rss/topics/science.xml' },
    { category: 'エンタメ', url: 'https://news.yahoo.co.jp/rss/topics/entertainment.xml' },
    { category: 'スポーツ', url: 'https://news.yahoo.co.jp/rss/topics/sports.xml' },
];
// Not for a light, cheerful opening: deaths, crime, disasters, war, politics, illness and people's private troubles.
const SENSITIVE = /死|亡|殺|遺体|事故|事件|逮捕|容疑|被害|被告|判決|裁判|訴訟|地震|津波|台風|豪雨|災害|火災|噴火|戦争|侵攻|攻撃|爆発|テロ|ミサイル|選挙|首相|大統領|政権|政党|議員|知事|内閣|国会|病|感染|入院|手術|体調|休止|引退|自殺|虐待|暴行|不倫|離婚|熱愛|交際|謝罪|炎上|不祥事|詐欺|誘拐|行方不明|閉鎖|倒産|解雇|リストラ|性的|ハラスメント|重傷|負傷|けが|怪我|停止|難民|障害|流出|漏えい|不正|違反|処分|批判|抗議/;
export const TOPICS_PER_SHOW = 4;

const decode = s => String(s).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const plain = s => decode(s).replace(/[<>\u0000-\u001f]/g, '').replace(/https?:\/\/\S+/g, '').trim();

/** RSS items -> [{ title, link, at }]; anything that is not a plain headline is skipped. */
export function parseFeed(xml) {
    return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
        title: plain(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').slice(0, 40),
        link: decode(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '').trim(),
        at: decode(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '').trim(),
    })).filter(i => i.title.length >= 4);
}

export const suitable = title => !SENSITIVE.test(title);

/** One headline as a lobby scene: introduce it within what the headline says, Noa's own take, then a light question. */
export function topicScene(topic, n) {
    const t = topic.title;
    return { id: `news-${n}`, title: t, first: true,
        premise: `今日話題のニュース（${topic.category}）：「${t}」。分かるのはこの見出しだけ。見出しにない数字・人名・経緯は足さない。`,
        beats: [
            { id: 'intro', label: '話題の紹介', action: '紹介', task: `今日話題の「${t}」を、見出しの範囲で一言で紹介する。見出しにない事実は足さない。`, minChars: 20, maxChars: 70, demo: `今日のニュースで「${t}」っていうのを見かけたよ！` },
            { id: 'feeling', label: 'ノアの感想', action: '感想', task: 'この話題へのノアの素直な感想か、もし自分ならどうするかを一つ言う。事実は増やさない。', minChars: 20, maxChars: 70, demo: 'もし私だったら、ちょっと気になって調べちゃいそう。' },
            { id: 'ask', label: 'みんなに聞く', action: '問いかけ', task: 'この話題について、見ている人が一言で答えやすい軽い問いかけを一つする。', minChars: 15, maxChars: 60, demo: 'みんなはこの話題、どう思った？' },
        ] };
}

/** The day's picks: one suitable headline per feed in turn, up to TOPICS_PER_SHOW. A feed that fails is skipped. */
export async function fetchTopics(fetchFn = fetch, { feeds = TOPIC_FEEDS, count = TOPICS_PER_SHOW } = {}) {
    const lists = await Promise.all(feeds.map(async f => {
        try {
            const r = await fetchFn(f.url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
            if (!r.ok) return [];
            return parseFeed(await r.text()).filter(i => suitable(i.title)).map(i => ({ ...i, category: f.category }));
        } catch { return []; }
    }));
    const picks = [], seen = new Set();
    for (let i = 0; picks.length < count && lists.some(l => l.length > i); i++)
        for (const l of lists) if (l[i] && !seen.has(l[i].title) && picks.length < count) { seen.add(l[i].title); picks.push(l[i]); }
    return picks;
}

/** Writes data/lobby-scenes.json: today's news scenes first (in order), the operator's own scenes after them, unmarked
 * as first so they are shuffled into the rest of the lobby. Keeps a dated memo. -> { scenes, memo } */
export function saveTopicScenes(dataDir, builtinScenes, topics, now = new Date()) {
    const file = join(dataDir, 'lobby-scenes.json');
    let own = builtinScenes;
    try { if (existsSync(file)) own = JSON.parse(readFileSync(file, 'utf8')).scenes || builtinScenes; } catch { /* a broken file is replaced */ }
    const rest = own.filter(s => !String(s.id).startsWith('news-')).map(({ first, ...s }) => s);
    const news = topics.map((t, i) => topicScene(t, i + 1));
    const scenes = [...news, ...rest].slice(0, 16);
    lobbyCards([{ id: 'probe', title: 'probe', angles: ['probe'], beats: [{ lobby: true }] }], scenes); // throws when invalid
    writeFileSync(`${file}.tmp`, JSON.stringify({ scenes }, null, 2) + '\n');
    renameSync(`${file}.tmp`, file);
    const day = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    mkdirSync(join(dataDir, 'topics'), { recursive: true });
    const memo = join(dataDir, 'topics', `${day}.md`);
    writeFileSync(memo, `# ${day} 雑談テーマ（自動収集 ${now.toISOString()}）\n\n` +
        (topics.length ? topics.map((t, i) => `${i + 1}. [${t.category}] ${t.title}\n   ${t.link}\n   ${t.at}`).join('\n') : '（取得できた話題はありません）') + '\n');
    return { scenes, memo };
}
