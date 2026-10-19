import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { setup } from './helpers.mjs';
import { ShowLogger } from '../src/show-logger.mjs';
import { createApp } from '../src/server.mjs';
test('comparison retains six live sessions, excludes demos and never exports viewer text', async t => {
    const c = setup(t), logger = new ShowLogger(c.dataDir);
    for (let i = 0; i < 8; i++) {
        const sessionId = `show_${i}`;
        logger.log({ type: 'show_start', sessionId, mode: 'live', at: `2026-10-01T0${i}:00:00Z`, programmeTitle: 'Noa' });
        logger.log({ type: 'speech', sessionId, text: 'private transcript', comment: 'private comment' });
        if (i > 2) logger.log({ type: 'participation', sessionId, participation: { youtube: { received: i }, participationRate: null } });
        logger.log({ type: 'show_stop', sessionId, at: `2026-10-01T0${i}:30:00Z` });
    }
    logger.log({ type: 'show_start', sessionId: 'demo', mode: 'demo' });
    appendFileSync(logger.logFile, 'broken record\n');
    const sessions = await logger.participationSessions();
    assert.deepEqual(sessions.map(s => s.sessionId), ['show_7', 'show_6', 'show_5', 'show_4', 'show_3', 'show_2']);
    assert.equal(sessions.at(-1).participation, null);
    assert.equal(sessions[0].participation.youtube.received, 7);
    assert.doesNotMatch(JSON.stringify(sessions), /private/);
    assert.equal((await logger.participationSessions(2)).length, 2);
});
test('authenticated programme export includes current and historical participation with no provider calls', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.port = 0;
    const app = createApp(c);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    try {
        const url = `http://127.0.0.1:${app.server.address().port}/api/programme/report`;
        assert.equal((await fetch(url)).status, 401);
        const r = await fetch(url, { headers: { Authorization: `Bearer ${c.adminToken}` } });
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.participation.participationRate, null);
        assert.deepEqual(body.recentParticipation, []);
        assert.equal(body.transcriptIncluded, false);
    } finally { await app.close(); }
});
