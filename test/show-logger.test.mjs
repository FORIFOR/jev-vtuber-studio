import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShowLogger } from '../src/show-logger.mjs';

test('ShowLogger: records speech, comment, progress and computes session analysis', t => {
    const dir = mkdtempSync(join(tmpdir(), 'showlogger-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const logger = new ShowLogger(dir);
    const sid = logger.startSession({
        programmeId: 'room',
        programmeTitle: '家具は3つだけ',
        mode: 'live',
        characterName: 'Noah'
    });

    assert.ok(sid.startsWith('show_'));

    logger.logSpeech({
        turn: 1,
        kind: 'opening',
        act: 1,
        actTitle: '生活の土台',
        beatId: 'intro',
        beatLabel: '導入',
        text: '家具を三つに絞った部屋で、まず服をどこに置くか考えてみよう。',
        audioMs: 4000,
        similarity: 0.1
    });

    logger.logCommentRead({
        author: '視聴者A',
        commentText: '服はハンガーで吊るせば？',
        readText: 'コメント。服はハンガーで吊るせば？',
        audioMs: 2500
    });

    logger.logSpeech({
        turn: 2,
        kind: 'reply',
        act: 1,
        actTitle: '生活の土台',
        beatId: 'storage_clothes',
        beatLabel: '服の居場所がない',
        text: 'ハンガーラックを足すと4つ目になっちゃうんだよね。',
        comment: '服はハンガーで吊るせば？',
        audioMs: 3500,
        similarity: 0.15
    });

    logger.logProgression({
        topicId: 'room',
        beatId: 'storage_clothes',
        label: '服の居場所がない',
        turn: 2,
        elapsedMs: 15000
    });

    logger.logRepair({
        reason: 'near_duplicate',
        attempt: 1,
        beatId: 'storage_clothes',
        instruction: '新しい具体例を述べる'
    });

    logger.stopSession({ reason: 'operator' });

    assert.ok(existsSync(join(dir, 'show-log.jsonl')));

    const sessions = logger.getSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, sid);
    assert.equal(sessions[0].speechCount, 2);
    assert.equal(sessions[0].commentCount, 1);
    assert.equal(sessions[0].progressCount, 1);
    assert.equal(sessions[0].repairCount, 1);

    const report = logger.analyzeSession(sid);
    assert.ok(report);
    assert.equal(report.sessionId, sid);
    assert.equal(report.programmeTitle, '家具は3つだけ');
    assert.equal(report.summary.speechCount, 2);
    assert.equal(report.summary.commentsRead, 1);
    assert.equal(report.summary.distinctBeatsCount, 1);
    assert.equal(report.summary.repairAttempts, 1);
    assert.equal(report.summary.totalChars, '家具を三つに絞った部屋で、まず服をどこに置くか考えてみよう。'.length + 'ハンガーラックを足すと4つ目になっちゃうんだよね。'.length);
    assert.equal(report.timeline.length, 4); // 2 speeches + 1 comment + 1 repair
});

test('viewer comment text and authors are erased after the retention period; what Noa said stays', t => {
    const dir = mkdtempSync(join(tmpdir(), 'jvs-retention-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const day = 86400000, now = Date.parse('2026-10-20T00:00:00Z'), at = d => new Date(now - d * day).toISOString();
    writeFileSync(join(dir, 'show-log.jsonl'), [
        { type: 'speech', text: '古い返事', comment: '古いコメント', at: at(8) },
        { type: 'comment_read', author: 'someone', commentText: '古いコメント', readText: 'コメント。古いコメント', audioMs: 900, at: at(8) },
        { type: 'speech', text: '新しい返事', comment: '新しいコメント', at: at(2) },
        { type: 'comment_read', author: 'other', commentText: '新しいコメント', readText: 'コメント。新しいコメント', at: at(2) },
        { type: 'speech', text: 'ふつうの発言', comment: null, at: at(30) },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    const logger = new ShowLogger(dir, { retentionDays: 7, now: () => now });
    const lines = readFileSync(join(dir, 'show-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines[0], { type: 'speech', text: '古い返事', comment: null, at: at(8) });
    assert.deepEqual(lines[1], { type: 'comment_read', audioMs: 900, at: at(8) });
    assert.equal(lines[2].comment, '新しいコメント'); assert.equal(lines[3].commentText, '新しいコメント');
    assert.equal(lines[4].text, 'ふつうの発言');
    assert.equal(logger.pruneComments(), 0, 'nothing left to erase');
});
