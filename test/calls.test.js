const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createHmac } = require('node:crypto');
const { io } = require('socket.io-client');
const { createChatServer } = require('../server');
const { callConfiguration } = require('../calls');

async function fixture(t, options = {}) {
    const chat = createChatServer({ dbPath: ':memory:', secureCookies: false, callEnv: { CALL_ALLOW_DIRECT: 'true' }, ...options });
    chat.server.listen(0, '127.0.0.1'); await once(chat.server, 'listening');
    const url = `http://127.0.0.1:${chat.server.address().port}`;
    const sockets = [];
    t.after(async () => { sockets.forEach(socket => socket.disconnect()); await chat.close(); });
    async function guest(cookie) {
        let user;
        if (!cookie) {
            const response = await fetch(`${url}/api/guest`, { method: 'POST' });
            assert.equal(response.status, 200);
            cookie = response.headers.get('set-cookie').split(';')[0];
            user = (await response.json()).user;
        }
        const socket = io(url, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { Cookie: cookie } });
        sockets.push(socket);
        const connected = once(socket, 'connect'); socket.connect(); await connected;
        return { socket, user, cookie };
    }
    return { chat, url, guest };
}
const request = (client, event, data) => client.socket.timeout(2000).emitWithAck(event, data);

test('TURN is required by default, credentials are scoped and the shared secret never leaves the server', () => {
    assert.equal(callConfiguration({}, 1).enabled, false);
    const env = { TURN_URLS: 'turn:relay.example:3478?transport=udp,turns:relay.example:443?transport=tcp', TURN_SHARED_SECRET: 'test-secret' };
    const config = callConfiguration(env, -1);
    assert.equal(config.enabled, true);
    assert.equal(config.iceTransportPolicy, 'relay');
    const server = config.iceServers[0];
    assert.equal(server.urls.length, 2);
    assert.equal(server.credential, createHmac('sha1', env.TURN_SHARED_SECRET).update(server.username).digest('base64'));
    assert.ok(Number(server.username.split(':')[0]) > Date.now() / 1000);
    assert.equal(JSON.stringify(config).includes('test-secret'), false);
    assert.equal(callConfiguration({ TURN_URLS: 'https://not-turn.example', TURN_USERNAME: 'x', TURN_PASSWORD: 'y' }, 1).enabled, false);
});

test('call configuration requires a session and requests fail clearly without TURN', { timeout: 10000 }, async t => {
    const f = await fixture(t, { callEnv: {} });
    assert.equal((await fetch(`${f.url}/api/calls/config`)).status, 401);
    const a = await f.guest(); const b = await f.guest();
    const response = await fetch(`${f.url}/api/calls/config`, { headers: { Cookie: a.cookie } });
    assert.equal((await response.json()).enabled, false);
    assert.match((await request(a, 'call:request', { userId: b.user.id })).error, /중계/);
});

test('only the selected two sockets may exchange signals, with one accepting tab per user', { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const a = await f.guest(); const b = await f.guest(); const bTab = await f.guest(b.cookie); const stranger = await f.guest();
    const incoming = once(b.socket, 'call:incoming');
    const ringingTab = once(bTab.socket, 'call:incoming');
    const { id } = await request(a, 'call:request', { userId: b.user.id });
    assert.equal((await incoming)[0].userId, a.user.id);
    assert.equal((await ringingTab)[0].id, id);
    assert.ok((await request(stranger, 'call:accept', { id })).error);
    assert.ok((await request(stranger, 'call:end', { id })).error);
    assert.ok((await request(stranger, 'call:request', { userId: a.user.id })).error);
    const accepted = once(a.socket, 'call:accepted'); const handled = once(bTab.socket, 'call:ended');
    assert.equal((await request(b, 'call:accept', { id })).ok, true);
    await accepted;
    assert.equal((await handled)[0].reason, 'answered-elsewhere');
    assert.ok((await request(bTab, 'call:accept', { id })).error);
    assert.ok((await request(bTab, 'call:end', { id })).error);
    const payload = { id, description: { type: 'offer', sdp: 'test-offer' } };
    assert.ok((await request(stranger, 'call:signal', payload)).error);
    assert.ok((await request(b, 'call:signal', payload)).error);
    const signal = once(b.socket, 'call:signal');
    assert.equal((await request(a, 'call:signal', payload)).ok, true);
    assert.equal((await signal)[0].description.sdp, 'test-offer');
    assert.ok((await request(a, 'call:signal', { id, candidate: {} })).error);
    assert.equal((await request(a, 'call:connected', { id })).ok, true);
    assert.equal((await request(b, 'call:connected', { id })).ok, true);
    const ended = once(a.socket, 'call:ended');
    assert.equal((await request(b, 'call:end', { id })).ok, true);
    await ended;
    assert.ok((await request(a, 'call:signal', payload)).error);
    assert.ok((await request(stranger, 'call:request', { userId: b.user.id })).id);
});

test('unanswered calls release both users, and a caller can cancel without waiting for acknowledgement', { timeout: 10000 }, async t => {
    const f = await fixture(t, { callRingMs: 80 });
    const a = await f.guest(); const b = await f.guest();
    const ended = once(a.socket, 'call:ended');
    await request(a, 'call:request', { userId: b.user.id });
    assert.equal((await ended)[0].reason, 'no-answer');
    const cancelled = once(a.socket, 'call:ended');
    const result = await request(b, 'call:request', { userId: a.user.id });
    assert.ok(result.id);
    assert.equal((await request(b, 'call:cancel', {})).ok, true);
    assert.equal((await cancelled)[0].reason, 'ended');
});

test('disconnecting the selected socket ends the call even if another account tab remains', { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const a = await f.guest(); const b = await f.guest(); await f.guest(a.cookie);
    const { id } = await request(a, 'call:request', { userId: b.user.id });
    await request(b, 'call:accept', { id });
    const ended = once(b.socket, 'call:ended');
    a.socket.disconnect();
    assert.equal((await ended)[0].reason, 'disconnected');
});

test('accepted calls that never connect time out and release the participants', { timeout: 10000 }, async t => {
    const f = await fixture(t, { callConnectMs: 80 });
    const a = await f.guest(); const b = await f.guest();
    const { id } = await request(a, 'call:request', { userId: b.user.id });
    const ended = once(a.socket, 'call:ended');
    await request(b, 'call:accept', { id });
    await request(a, 'call:connected', { id });
    assert.equal((await ended)[0].reason, 'connection-timeout');
    assert.ok((await request(b, 'call:request', { userId: a.user.id })).id);
});

test('an expired or revoked session cannot send call signals', { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const a = await f.guest(); const b = await f.guest();
    const { id } = await request(a, 'call:request', { userId: b.user.id });
    await request(b, 'call:accept', { id });
    const ended = once(b.socket, 'call:ended');
    const response = await fetch(`${f.url}/api/logout`, { method: 'POST', headers: { Cookie: a.cookie } });
    assert.equal(response.status, 200);
    assert.equal((await ended)[0].reason, 'disconnected');
});
