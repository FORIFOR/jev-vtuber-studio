import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { setup } from './helpers.mjs';

test('GET /api/comments and GET /api/chat return comment status and list with authorization', async (t) => {
    const c = setup(t, {
        SHOW_PROFILE: 'talk',
        READ_COMMENTS: 'true',
        YOUTUBE_TRANSPORT: 'poll',
        YOUTUBE_VIDEO_ID: 'test-vid-123'
    });

    const app = createApp(c);
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    t.after(() => app.server.close());
    const base = `http://127.0.0.1:${app.server.address().port}`;

    const req = async (path, { method = 'GET', token = null, body = null } = {}) => {
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        if (body) headers['Content-Type'] = 'application/json';
        const res = await fetch(base + path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
        });
        const data = await res.json().catch(() => null);
        return { status: res.status, data };
    };

    // 1. Unauthorized without token
    const unauth = await req('/api/comments');
    assert.equal(unauth.status, 401);

    // 2. Authorized with viewToken
    const viewRes = await req('/api/comments', { token: c.viewToken });
    assert.equal(viewRes.status, 200);
    assert.equal(viewRes.data.ok, true);
    assert.equal(viewRes.data.transport, 'poll');
    assert.ok(Array.isArray(viewRes.data.queue));
    assert.ok(Array.isArray(viewRes.data.candidates));
    assert.ok(Array.isArray(viewRes.data.recent));

    // 3. Authorized with adminToken on /api/chat (GET)
    const chatGet = await req('/api/chat', { token: c.adminToken });
    assert.equal(chatGet.status, 200);
    assert.equal(chatGet.data.ok, true);
    assert.equal(chatGet.data.transport, 'poll');

    // 4. Ingest a comment via POST /api/chat when running
    app.engine.running = true;
    const postRes = await req('/api/chat', { method: 'POST', token: c.adminToken, body: { text: 'テストコメントです！' } });
    assert.equal(postRes.status, 200);
    assert.equal(postRes.data.accepted, true);

    // 5. Verify the comment appears in GET /api/comments
    const updated = await req('/api/comments', { token: c.viewToken });
    assert.equal(updated.status, 200);
    assert.ok(updated.data.recent.some(x => x.text.includes('テストコメントです')));
});
