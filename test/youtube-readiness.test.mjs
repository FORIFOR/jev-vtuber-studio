import test from 'node:test';
import assert from 'node:assert/strict';
import { grpcAvailable } from '../src/youtube-stream.mjs';
import { youtubeChatStartIssue } from '../src/youtube.mjs';

test('youtube readiness: streaming packages are detected without loading them', () => {
    assert.equal(grpcAvailable(() => '/x'), true);
    assert.equal(grpcAvailable(name => { if (name === '@grpc/proto-loader') throw new Error('missing'); return '/x'; }), false);
});

test('youtube readiness: a spent daily budget is reported before the show (2026-10-05: 1000/1000 left comments unread)', () => {
    const c = { mode: 'live', readComments: true, streamTarget: 'simulcast', youtubeChannel: 'UC1', youtubeVideo: '' };
    assert.equal(youtubeChatStartIssue(c, { limits: { youtube: 1000 }, calls: { youtube: 10 } }), null);
    assert.equal(youtubeChatStartIssue(c, { limits: { youtube: 1000 }, calls: { youtube: 1000 } }).code, 'YOUTUBE_CHAT_BUDGET');
});
