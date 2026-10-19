import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { setup } from './helpers.mjs';

test('persona saves through real HTTP; invalid credentials return only a field-specific validation error', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.port = 0;
    const app = createApp(c); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(() => app.close());
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = values => fetch(base + '/api/settings', { method: 'POST', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
    const valid = await post({ CHARACTER_PERSONA: 'ゆっくり話す。\r\n質問は少なく。' });
    assert.equal(valid.status, 200); const data = await valid.json(); assert.equal(data.values.CHARACTER_PERSONA, 'ゆっくり話す。\n質問は少なく。');
    const bad = await post({ TYPESAFE_API_KEY: 'DO-NOT-ECHO\nDUMMY' }); const error = await bad.json();
    assert.equal(bad.status, 400); assert.equal(error.field, 'TYPESAFE_API_KEY'); assert.ok(!JSON.stringify(error).includes('DO-NOT-ECHO'));
    const unchanged = await (await fetch(base + '/api/settings', { headers: { Authorization: `Bearer ${c.adminToken}` } })).json();
    assert.equal(unchanged.values.CHARACTER_PERSONA, 'ゆっくり話す。\n質問は少なく。'); assert.equal(unchanged.configured.TYPESAFE_API_KEY, false);
});
