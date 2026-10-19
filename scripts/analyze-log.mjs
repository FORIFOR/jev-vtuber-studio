#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ShowLogger } from '../src/show-logger.mjs';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const dataDir = process.env.DATA_DIR || join(ROOT, 'data');
const showLogger = new ShowLogger(dataDir);

const args = process.argv.slice(2);
const isAll = args.includes('--all');
const isMarkdown = args.includes('--markdown');
const isJson = args.includes('--json');
const isTimeline = args.includes('--timeline');
const sessionIdx = args.indexOf('--session');
const targetSessionId = sessionIdx !== -1 && args[sessionIdx + 1] ? args[sessionIdx + 1] : null;

const sessions = showLogger.getSessions();

if (!sessions.length) {
    console.log('配信ログが見つかりませんでした。配信を開始・進行すると data/show-log.jsonl に記録されます。');
    process.exit(0);
}

if (isAll) {
    if (isJson) {
        console.log(JSON.stringify(sessions, null, 2));
        process.exit(0);
    }
    console.log('=== 過去の配信セッション一覧 ===\n');
    console.log(String('開始時刻').padEnd(25) + String('企画').padEnd(20) + String('発言数').padStart(8) + String('コメント').padStart(8) + String('進捗').padStart(8) + String('状態').padStart(12));
    console.log('-'.repeat(85));
    for (const s of sessions) {
        const at = s.startedAt ? new Date(s.startedAt).toLocaleString('ja-JP') : '不明';
        const prog = (s.programmeTitle || s.programmeId || '雑談').slice(0, 18);
        const status = s.stalled ? '停滞停止' : (s.stopReason || '進行中/完了');
        console.log(at.padEnd(25) + prog.padEnd(20) + String(s.speechCount).padStart(8) + String(s.commentCount).padStart(8) + String(s.progressCount).padStart(8) + String(status).padStart(12));
    }
    console.log('\n※ 各セッションの詳細分析: node scripts/analyze-log.mjs --session <sessionId>');
    process.exit(0);
}

const analysis = showLogger.analyzeSession(targetSessionId);
if (!analysis) {
    console.error(`指定されたセッション ${targetSessionId} のログが見つかりませんでした。`);
    process.exit(1);
}

if (isJson) {
    console.log(JSON.stringify(analysis, null, 2));
    process.exit(0);
}

const s = analysis.summary;

if (isMarkdown) {
    console.log(`# 配信分析レポート: ${analysis.programmeTitle}\n`);
    console.log(`- **セッションID**: \`${analysis.sessionId}\``);
    console.log(`- **開始日時**: ${new Date(analysis.startedAt).toLocaleString('ja-JP')}`);
    console.log(`- **終了日時**: ${new Date(analysis.stoppedAt).toLocaleString('ja-JP')}`);
    console.log(`- **総配信時間**: ${analysis.durationFormatted}`);
    console.log(`- **終了理由**: ${analysis.stopReason}\n`);

    console.log(`## 1. 配信サマリーと話速\n`);
    console.log(`| 項目 | 実績値 | 評価・備考 |`);
    console.log(`| :--- | :--- | :--- |`);
    console.log(`| **総発言数** | ${s.speechCount} 回 | キャラクターのコミット済み発言数 |`);
    console.log(`| **総文字数** | ${s.totalChars} 文字 | 1発言平均 約${s.avgCharsPerTurn}文字 |`);
    console.log(`| **総音声時間** | ${s.totalAudioSec} 秒 | 実再生時間 |`);
    console.log(`| **平均話速** | ${s.avgCharsPerSec} 文字/秒 | 快適な聴取目安: 5〜8字/秒 |`);
    console.log(`| **読上げコメント数** | ${s.commentsRead} 件 | VOICEVOXで読上げたコメント |`);
    console.log(`| **クリアした課題数** | ${s.distinctBeatsCount} / 27 課題 | 番組企画の進捗状況 |`);
    console.log(`| **最大類似度** | ${s.maxSimilarity} | 0.82以上で重複警戒 |`);
    console.log(`| **再生成(Repair)回数** | ${s.repairAttempts} 回 | 言い換え・課題未達による自動修正 |`);
    console.log(`| **停滞停止(Stalled)** | ${s.stalled ? '発生あり' : 'なし (正常)'} | 品質保持のための自動停止 |\n`);

    console.log(`## 2. 発言タイムライン\n`);
    console.log(`| 時間 | 種類 / 課題 | 発言・読上げ内容 | 類似度 / 音声 |`);
    console.log(`| :--- | :--- | :--- | :--- |`);
    for (const item of analysis.timeline) {
        const textEsc = item.text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        const simAudio = [
            item.similarity !== null ? `類似度:${item.similarity}` : '',
            item.audioMs ? `${(item.audioMs / 1000).toFixed(1)}s` : ''
        ].filter(Boolean).join(' / ');
        console.log(`| \`${item.time}\` | ${item.label} | ${textEsc} | ${simAudio} |`);
    }
    process.exit(0);
}

// Terminal Human-Readable Output
const CYAN = '\x1b[36m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m', BOLD = '\x1b[1m', RESET = '\x1b[0m', DIM = '\x1b[2m';

console.log(`${BOLD}${CYAN}========================================================================${RESET}`);
console.log(`${BOLD}               Jev VTuber Studio - 配信ログ分析レポート                 ${RESET}`);
console.log(`${BOLD}${CYAN}========================================================================${RESET}\n`);

console.log(`${BOLD}【番組情報】${RESET}`);
console.log(`  企画タイトル  : ${BOLD}${analysis.programmeTitle}${RESET} (${analysis.programmeId})`);
console.log(`  セッションID  : ${DIM}${analysis.sessionId}${RESET}`);
console.log(`  開始〜終了    : ${new Date(analysis.startedAt).toLocaleTimeString('ja-JP')} 〜 ${new Date(analysis.stoppedAt).toLocaleTimeString('ja-JP')} (${BOLD}${analysis.durationFormatted}${RESET})`);
console.log(`  終了ステータス: ${analysis.stopReason === 'stalled' ? RED + '停滞検知による自動安全停止' : GREEN + (analysis.stopReason || '正常終了')}${RESET}\n`);

console.log(`${BOLD}【トーク・話速サマリー】${RESET}`);
console.log(`  発言回数      : ${BOLD}${s.speechCount}${RESET} 回 （コメント読上げ: ${BOLD}${s.commentsRead}${RESET} 件）`);
console.log(`  総発言文字数  : ${BOLD}${s.totalChars}${RESET} 文字 （1発言平均: 約 ${s.avgCharsPerTurn} 文字）`);
console.log(`  総音声再生時間: ${BOLD}${s.totalAudioSec}${RESET} 秒 （平均話速: ${BOLD}${s.avgCharsPerSec}${RESET} 文字/秒）\n`);

console.log(`${BOLD}【企画進行度・課題達成状況】${RESET}`);
const pct = Math.round((s.distinctBeatsCount / 27) * 100);
const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
console.log(`  進捗率        : [${GREEN}${bar}${RESET}] ${BOLD}${pct}%${RESET} (${s.distinctBeatsCount} / 27 課題達成)`);
console.log(`  総進行ステップ: ${s.progressions} 回\n`);

console.log(`${BOLD}【品質・重複検査 (ループ防止の検証)】${RESET}`);
const simColor = s.maxSimilarity >= 0.8 ? RED : s.maxSimilarity >= 0.6 ? YELLOW : GREEN;
console.log(`  最大類似度    : ${simColor}${s.maxSimilarity}${RESET} (直前発言との3-gram類似度。0.82以上でブロック)`);
console.log(`  平均類似度    : ${s.avgSimilarity}`);
console.log(`  自動修復回数  : ${s.repairAttempts ? YELLOW + s.repairAttempts + ' 回 (言い換え等を自己修正)' : GREEN + '0 回 (一発合格)'}${RESET}`);
console.log(`  停滞安全停止  : ${s.stalled ? RED + '発生 (同じ課題で停止)' : GREEN + 'なし (健全に進行)'}${RESET}\n`);

console.log(`${BOLD}${CYAN}------------------------------------------------------------------------${RESET}`);
console.log(`${BOLD}                           発言タイムライン                             ${RESET}`);
console.log(`${BOLD}${CYAN}------------------------------------------------------------------------${RESET}`);

if (!analysis.timeline.length) {
    console.log('  発言記録はありません。');
} else {
    for (const item of analysis.timeline) {
        const timeBadge = `${DIM}[${item.time}]${RESET}`;
        if (item.type === 'comment_read') {
            console.log(`\n${timeBadge} ${YELLOW}💬 コメント読上${RESET} ${DIM}(音声: ${(item.audioMs/1000).toFixed(1)}s)${RESET}`);
            console.log(`   ${DIM}投稿者: ${item.author || '視聴者'}${RESET}`);
            console.log(`   「${item.text}」`);
        } else if (item.type === 'speech') {
            const roleBadge = item.role === 'host' ? `${CYAN}🎤 ホスト${RESET}` : `${DIM}システム${RESET}`;
            const labelBadge = item.label ? `${BOLD}【${item.label}】${RESET}` : '';
            const meta = [
                item.similarity !== null ? `類似度:${item.similarity}` : '',
                item.audioMs ? `${(item.audioMs/1000).toFixed(1)}s` : '',
                item.mood ? `表情:${item.mood}` : ''
            ].filter(Boolean).join(' | ');
            console.log(`\n${timeBadge} ${roleBadge} ${labelBadge} ${DIM}(${meta})${RESET}`);
            if (item.commentOriginal) {
                console.log(`   ${DIM}↳ 返答先: 「${item.commentOriginal.slice(0, 60)}」${RESET}`);
            }
            console.log(`   「${item.text}」`);
        } else if (item.type === 'content_repair') {
            console.log(`\n${timeBadge} ${YELLOW}⚠️ 自動修復実行: ${item.text} (課題: ${item.label})${RESET}`);
        } else if (item.type === 'content_stalled') {
            console.log(`\n${timeBadge} ${RED}🛑 停滞停止検知: ${item.text}${RESET}`);
        }
    }
}

console.log(`\n${BOLD}${CYAN}========================================================================${RESET}`);
console.log(`${DIM}※ Markdownで出力する場合: npm run log:analyze -- --markdown${RESET}`);
console.log(`${DIM}※ 過去セッション一覧表示: npm run log:analyze -- --all${RESET}\n`);
