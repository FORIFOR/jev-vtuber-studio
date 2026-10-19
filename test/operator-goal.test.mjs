import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { setup } from './helpers.mjs';

test('the operator changes the stream goal at any time: box text, settings.json, state event', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', GAME_GOAL: '最初の目標' });
    Object.assign(c, { port: 0 });
    const app = createApp(c); await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const req = (path, data, token = c.adminToken) => fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const states = []; app.engine.on('event', e => { if (e.type === 'state') states.push(e); });
    try {
        assert.equal((await req('/api/operator/goal', { text: 'x' }, c.viewToken)).status, 401);
        assert.equal((await req('/api/operator/goal', { text: '  ' })).status, 400);
        const r = await (await req('/api/operator/goal', { text: '監督を倒して<b>エンディング</b>へ\n' })).json();
        assert.equal(r.goal, '監督を倒してbエンディング/bへ');
        assert.equal(c.gameGoal, r.goal);
        assert.equal(c.settingsEnv.GAME_GOAL, r.goal);
        assert.equal(JSON.parse(readFileSync(join(c.dataDir, 'settings.json'), 'utf8')).GAME_GOAL, r.goal);
        assert.ok(states.length >= 1);
    } finally { await app.close(); }
});
