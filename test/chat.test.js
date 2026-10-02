const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createChatServer } = require('../server');
const { addUser } = require('../store');

const password = 'test-only-password-123';
async function fixture(t, dbPath = ':memory:', seed = true, options = {}) {
    const chat = createChatServer({ dbPath, secureCookies: false, publicOrigin: undefined, ...options });
    if (seed) { addUser(chat.db, 1, '하나', password); addUser(chat.db, 2, '둘', password); }
    chat.server.listen(0, '127.0.0.1');
    await once(chat.server, 'listening');
    const url = `http://127.0.0.1:${chat.server.address().port}`;
    const sockets = [];
    let closed = false;
    async function close() { if (!closed) { closed = true; sockets.forEach(socket => socket.disconnect()); await chat.close(); } }
    t.after(close);
    async function login(name = '하나') {
        const response = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password }) });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
        return response.headers.get('set-cookie').split(';')[0];
    }
    async function connect(cookie) {
        const socket = io(url, { transports: ['websocket'], extraHeaders: { Cookie: cookie }, autoConnect: false, reconnection: false });
        sockets.push(socket);
        const connected = once(socket, 'connect');
        socket.connect();
        await connected;
        return socket;
    }
    async function get(route, cookie) {
        const response = await fetch(`${url}${route}`, { headers: { Cookie: cookie } });
        assert.equal(response.status, 200);
        return response.json();
    }
    return { chat, url, login, connect, get, close };
}
function send(socket, data) { return socket.timeout(2000).emitWithAck('chat message', data); }

test('guest entry needs no fields or configured accounts and preserves a distinct session', { timeout: 10000 }, async t => {
    const f = await fixture(t, ':memory:', false);
    assert.equal((await fetch(`${f.url}/healthz`)).status, 200);
    const enter = async cookie => {
        const response = await fetch(`${f.url}/api/guest`, { method: 'POST', headers: cookie ? { Cookie: cookie } : {} });
        assert.equal(response.status, 200);
        return { user: (await response.json()).user, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
    };
    const a = await enter();
    const b = await enter();
    assert.ok(a.user.id < 0);
    assert.notEqual(a.user.id, b.user.id);
    assert.match(a.user.name, /^게스트 /);
    const repeated = await enter(a.cookie);
    assert.equal(repeated.user.id, a.user.id);
    assert.equal((await f.get('/api/me', a.cookie)).user.id, a.user.id);
    const first = await f.connect(a.cookie);
    const second = await f.connect(b.cookie);
    const received = once(second, 'chat message');
    const result = await send(first, { clientId: 'guest-message-00001', body: '게스트 대화', userId: 1 });
    assert.equal(result.message.userId, a.user.id);
    assert.equal((await received)[0].body, '게스트 대화');
    assert.equal((await f.get('/api/messages', b.cookie)).messages.length, 1);
    assert.equal((await f.get('/api/people', b.cookie)).people.filter(person => person.online).length, 2);
    assert.equal((await f.get('/api/visits', a.cookie)).visits.length, 2);
    const passwordAttempt = await fetch(`${f.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: a.user.name, password: '' }) });
    assert.equal(passwordAttempt.status, 401);
    const disconnected = once(first, 'disconnect');
    await fetch(`${f.url}/api/logout`, { method: 'POST', headers: { Cookie: a.cookie } });
    await disconnected;
    assert.equal((await fetch(`${f.url}/api/me`, { headers: { Cookie: a.cookie } })).status, 401);
});

test('guest access can be disabled and guest creation is rate limited', { timeout: 10000 }, async t => {
    const privateRoom = await fixture(t, ':memory:', true, { guestEnabled: false });
    assert.equal((await (await fetch(`${privateRoom.url}/api/config`)).json()).guestEnabled, false);
    assert.equal((await fetch(`${privateRoom.url}/api/guest`, { method: 'POST' })).status, 403);
    const openRoom = await fixture(t, ':memory:', false);
    for (let n = 0; n < 11; n++) {
        assert.equal((await fetch(`${openRoom.url}/api/guest`, { method: 'POST' })).status, n < 10 ? 200 : 429);
    }
});

test('unauthenticated requests and foreign origins cannot access the conversation', { timeout: 10000 }, async t => {
    const f = await fixture(t);
    for (const route of ['/api/me', '/api/people', '/api/messages', '/api/visits']) {
        assert.equal((await fetch(f.url + route)).status, 401);
    }
    const response = await fetch(`${f.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: JSON.stringify({ name: '하나', password }) });
    assert.equal(response.status, 403);
    const socket = io(f.url, { transports: ['websocket'], autoConnect: false, reconnection: false });
    t.after(() => socket.disconnect());
    const denied = once(socket, 'connect_error');
    socket.connect();
    assert.equal((await denied)[0].message, '로그인이 필요합니다.');
    assert.throws(() => addUser(f.chat.db, 3, '세번째', password));
    assert.equal((await fetch(`${f.url}/data/chat.sqlite`)).status, 404);
});

test('messages reach both users, retain authenticated identity, and retries are deduplicated', { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const aCookie = await f.login();
    const bCookie = await f.login('둘');
    const a = await f.connect(aCookie);
    const b = await f.connect(bCookie);
    const received = once(b, 'chat message');
    const payload = { body: '안녕! <script>alert(1)</script>', clientId: 'test-message-0000001', userId: 2, name: '위조' };
    const result = await send(a, payload);
    assert.equal(result.message.userId, 1);
    assert.equal((await received)[0].id, result.message.id);
    assert.equal((await send(a, payload)).message.id, result.message.id);
    const history = await f.get('/api/messages', bCookie);
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].body, payload.body);
    assert.ok(history.messages[0].createdAt);
    assert.ok((await send(a, { clientId: 'test-invalid-000001', body: '   ' })).error);
    assert.ok((await send(a, { clientId: 'test-invalid-000002', body: 'x'.repeat(4001) })).error);
    assert.ok((await send(a, null)).error);
    assert.equal((await f.get('/api/messages', aCookie)).messages.length, 1);
});

test('presence tracks the last connected tab, and logout revokes all sockets in that session', { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const cookie = await f.login();
    const observerCookie = await f.login('둘');
    const a1 = await f.connect(cookie);
    const a2 = await f.connect(cookie);
    const observer = await f.connect(observerCookie);
    assert.equal((await f.get('/api/visits', cookie)).visits.filter(v => v.userId === 1).length, 1);
    const serverSocket = f.chat.io.sockets.sockets.get(a1.id);
    const disconnected = once(serverSocket, 'disconnect');
    a1.disconnect(); await disconnected;
    assert.equal((await f.get('/api/people', observerCookie)).people[0].online, true);
    const presence = once(observer, 'presence');
    const revoked = once(a2, 'disconnect');
    assert.equal((await fetch(`${f.url}/api/logout`, { method: 'POST', headers: { Cookie: cookie } })).status, 200);
    await revoked;
    assert.equal((await presence)[0][0].online, false);
    assert.equal((await fetch(`${f.url}/api/messages`, { headers: { Cookie: cookie } })).status, 401);
    const visit = (await f.get('/api/visits', observerCookie)).visits.find(v => v.userId === 1);
    assert.ok(visit.leftAt);
    assert.equal(visit.endReason, 'disconnected');
});

test('history pages have no missing or duplicated records', { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const cookie = await f.login();
    const statement = f.chat.db.prepare('INSERT INTO messages (user_id, client_id, body, created_at) VALUES (1, ?, ?, ?)');
    for (let n = 1; n <= 121; n++) statement.run(`seed-${n}`, `메시지 ${n}`, new Date().toISOString());
    const ids = [];
    let before = '';
    for (;;) {
        const page = await f.get(`/api/messages${before}`, cookie);
        ids.push(...page.messages.map(message => message.id));
        if (!page.hasMore) break;
        before = `?before=${page.messages[0].id}`;
    }
    assert.equal(ids.length, 121);
    assert.equal(new Set(ids).size, 121);
    assert.equal((await fetch(`${f.url}/api/messages?before=oops`, { headers: { Cookie: cookie } })).status, 400);
});

test('server restart preserves messages and visits, invalidates sessions, and marks interrupted visits', { timeout: 10000 }, async t => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'webchat-test-'));
    const dbPath = path.join(directory, 'chat.sqlite');
    const first = await fixture(t, dbPath);
    const cookie = await first.login();
    const socket = await first.connect(cookie);
    await send(socket, { body: '재시작 후에도 남아요', clientId: 'persistent-message-1' });
    await first.close();
    const second = await fixture(t, dbPath, false);
    assert.equal((await fetch(`${second.url}/api/me`, { headers: { Cookie: cookie } })).status, 401);
    const newCookie = await second.login();
    assert.equal((await second.get('/api/messages', newCookie)).messages[0].body, '재시작 후에도 남아요');
    assert.ok((await second.get('/api/visits', newCookie)).visits[0].leftAt);
    second.chat.db.prepare('INSERT INTO visits (user_id, entered_at) VALUES (2, ?)').run(new Date().toISOString());
    await second.close();
    const third = await fixture(t, dbPath, false);
    const thirdCookie = await third.login();
    const interrupted = (await third.get('/api/visits', thirdCookie)).visits[0];
    assert.equal(interrupted.endReason, 'interrupted');
    assert.equal(interrupted.leftAt, null);
    await third.close();
    // Only remove this test's freshly-created temporary directory.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('webchat-test-'));
    rmSync(directory, { recursive: true });
});

test('incorrect passwords are rejected and repeated attempts are limited', { timeout: 10000 }, async t => {
    const f = await fixture(t);
    for (let n = 0; n < 11; n++) {
        const response = await fetch(`${f.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '하나', password: 'wrong-password' }) });
        assert.equal(response.status, n < 10 ? 401 : 429);
    }
});
