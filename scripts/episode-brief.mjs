#!/usr/bin/env node
// Local editorial metadata only. Never calls an API or changes a YouTube title.
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const programmes = JSON.parse(readFileSync(new URL('../config/programmes.json', import.meta.url), 'utf8'));
const character = JSON.parse(readFileSync(new URL('../config/character.json', import.meta.url), 'utf8'));
if (args.includes('--help')) {
    console.log('Usage: npm run episode:brief -- room|holiday|robot\nPrint original programme metadata. No network calls and no publishing.');
} else {
    const id = args[0] || 'room', p = programmes.find(x => x.id === id);
    if (!p || args.length > 1) { console.error('企画は room / holiday / robot / consultation から一つ選んでください。'); process.exitCode = 1; }
    else console.log(JSON.stringify({
        programmeId: id, title: p.title,
        thumbnailText: { room: '服、どこに置く？', holiday: '何もしないって何？', robot: '洗うだけでは終わらない。', consultation: '相談ない時はゲーム中' }[id],
        description: `AIキャラクターの${character.name}と、${p.title}\n${p.cards.map(c => c.title).join(' → ')}の順に考えます。コメントがなくても番組は進みます。\n採用コメントはVOICEVOXで読み上げ、AIが返答します。音声・キャラクターは合成です。\n※音声ライブラリの利用条件を確認し、実際に使用する声のクレジットを追記してください。`,
        rounds: p.cards.map(c => ({ title: c.title, questions: c.beats.map(b => b.display) })),
        note: '提案タイトル。結果や視聴者反応を捏造しない。時刻は実録後に記入。YouTubeには自動反映しません。'
    }, null, 2));
}
