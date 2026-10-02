const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { Server } = require('socket.io');
const { openStore, verifyPassword, initializeUsers } = require('./store');

function createChatServer({ dbPath, secureCookies = process.env.NODE_ENV === 'production', publicOrigin = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL, guestEnabled = process.env.ALLOW_GUESTS !== 'false' } = {}) {
    const db = openStore(dbPath);
    // A crash has no reliable disconnect timestamp: preserve that uncertainty.
    db.prepare("UPDATE visits SET end_reason = 'interrupted' WHERE left_at IS NULL AND end_reason IS NULL").run();
    const app = express();
    const server = http.createServer(app);
    const sessions = new Map();
    const online = new Map();
    const attempts = new Map();
    const guestAttempts = new Map();
    const messageRates = new Map();
    const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
    let closing = false;

    function allowedOrigin(req) {
        const origin = req.headers.origin;
        if (!origin) return true;
        const expected = publicOrigin || `${secureCookies ? 'https' : 'http'}://${req.headers.host}`;
        return origin === expected;
    }
    const io = new Server(server, {
        maxHttpBufferSize: 16384,
        allowRequest: (req, callback) => callback(null, allowedOrigin(req)),
    });
    function tokenKey(req) {
        const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('chat_session='))?.slice(13);
        return token ? createHash('sha256').update(token).digest('hex') : null;
    }
    function sessionFor(req) {
        const key = tokenKey(req);
        const session = sessions.get(key);
        return session && session.expires > Date.now() && (guestEnabled || session.userId > 0) ? { ...session, key } : null;
    }
    function cookie(token, age) {
        return `chat_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secureCookies ? '; Secure' : ''}`;
    }
    function createSession(req, res, user) {
        const oldKey = tokenKey(req);
        if (oldKey) { sessions.delete(oldKey); io.in(`session:${oldKey}`).disconnectSockets(true); }
        const token = randomBytes(32).toString('hex');
        sessions.set(createHash('sha256').update(token).digest('hex'), { userId: user.id, expires: Date.now() + sessionLifetime });
        res.setHeader('Set-Cookie', cookie(token, sessionLifetime / 1000));
        res.json({ user: { id: user.id, name: user.name } });
    }
    function requireAuth(req, res, next) {
        req.session = sessionFor(req);
        if (!req.session) return res.status(401).json({ error: '로그인이 필요합니다.' });
        next();
    }
    function people() {
        return db.prepare(`SELECT id, name,
            (SELECT entered_at FROM visits WHERE user_id = users.id ORDER BY id DESC LIMIT 1) AS lastEnteredAt,
            (SELECT left_at FROM visits WHERE user_id = users.id ORDER BY id DESC LIMIT 1) AS lastLeftAt,
            (SELECT end_reason FROM visits WHERE user_id = users.id ORDER BY id DESC LIMIT 1) AS lastEndReason
            FROM users ORDER BY id`).all().map(user => ({ ...user, online: online.has(user.id) }));
    }
    function presence() { io.emit('presence', people()); }
    function pageCursor(value) {
        if (value === undefined) return Number.MAX_SAFE_INTEGER;
        const number = Number(value);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
    }
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        res.set({
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        if (!allowedOrigin(req)) return res.status(403).json({ error: '허용되지 않은 요청입니다.' });
        next();
    });
    app.use(express.json({ limit: '16kb' }));
    app.get('/api/config', (req, res) => res.json({ guestEnabled }));
    app.get('/healthz', (req, res) => {
        const ready = guestEnabled || db.prepare('SELECT COUNT(*) AS count FROM users WHERE id > 0').get().count === 2;
        res.status(ready ? 200 : 503).json({ ok: ready });
    });
    app.post('/api/guest', (req, res) => {
        if (!guestEnabled) return res.status(403).json({ error: '게스트 입장이 꺼져 있습니다.' });
        const existing = sessionFor(req);
        if (existing) return res.json({ user: db.prepare('SELECT id, name FROM users WHERE id = ?').get(existing.userId) });
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        let attempt = guestAttempts.get(ip);
        if (!attempt || attempt.until <= now) attempt = { count: 0, until: now + 15 * 60 * 1000 };
        guestAttempts.set(ip, attempt);
        if (attempt.count >= 10) return res.status(429).json({ error: '게스트 입장이 많습니다. 15분 후 다시 시도하세요.' });
        attempt.count++;
        const id = Math.min(0, db.prepare('SELECT MIN(id) AS id FROM users').get().id || 0) - 1;
        let name = `게스트 ${-id}`;
        while (db.prepare('SELECT id FROM users WHERE name = ?').get(name)) name = `게스트 ${-id}-${randomBytes(3).toString('hex')}`;
        // Guests have no password login; only their server-issued session identifies them.
        db.prepare('INSERT INTO users (id, name, salt, password_hash) VALUES (?, ?, ?, ?)').run(id, name, '', '');
        createSession(req, res, { id, name });
    });
    app.post('/api/login', (req, res) => {
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        const attempt = attempts.get(ip) || { count: 0, until: now + 15 * 60 * 1000 };
        if (attempt.until <= now) { attempt.count = 0; attempt.until = now + 15 * 60 * 1000; }
        attempts.set(ip, attempt);
        if (attempt.count >= 10) return res.status(429).json({ error: '로그인 시도가 많습니다. 15분 후 다시 시도하세요.' });
        attempt.count++;
        const { name, password } = req.body || {};
        if (typeof name !== 'string' || typeof password !== 'string' || name.length > 24 || password.length > 128) {
            return res.status(400).json({ error: '이름과 비밀번호를 확인하세요.' });
        }
        const user = db.prepare('SELECT * FROM users WHERE name = ? AND id > 0').get(name.trim());
        if (!verifyPassword(user, password)) return res.status(401).json({ error: '이름 또는 비밀번호가 올바르지 않습니다.' });
        attempts.delete(ip);
        createSession(req, res, user);
    });
    app.get('/api/me', requireAuth, (req, res) => {
        res.json({ user: db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.session.userId) });
    });
    app.post('/api/logout', requireAuth, (req, res) => {
        sessions.delete(req.session.key);
        io.in(`session:${req.session.key}`).disconnectSockets(true);
        res.setHeader('Set-Cookie', cookie('', 0));
        res.json({ ok: true });
    });
    app.get('/api/people', requireAuth, (req, res) => res.json({ people: people() }));
    app.get('/api/messages', requireAuth, (req, res) => {
        const before = pageCursor(req.query.before);
        if (!before) return res.status(400).json({ error: '잘못된 페이지입니다.' });
        const rows = db.prepare(`SELECT id, user_id AS userId, client_id AS clientId, body, created_at AS createdAt
            FROM messages WHERE id < ? ORDER BY id DESC LIMIT 51`).all(before);
        res.json({ hasMore: rows.length > 50, messages: rows.slice(0, 50).reverse() });
    });
    app.get('/api/visits', requireAuth, (req, res) => {
        const before = pageCursor(req.query.before);
        if (!before) return res.status(400).json({ error: '잘못된 페이지입니다.' });
        const rows = db.prepare(`SELECT visits.id, user_id AS userId, users.name, entered_at AS enteredAt,
            left_at AS leftAt, end_reason AS endReason FROM visits JOIN users ON users.id = user_id
            WHERE visits.id < ? ORDER BY visits.id DESC LIMIT 51`).all(before);
        res.json({ hasMore: rows.length > 50, visits: rows.slice(0, 50) });
    });
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/api', (req, res) => res.status(404).json({ error: '경로를 찾을 수 없습니다.' }));
    app.use((error, req, res, next) => {
        console.error(error.message);
        res.status(error.status === 413 ? 413 : 500).json({ error: '요청을 처리하지 못했습니다.' });
    });
    io.use((socket, next) => {
        const session = sessionFor(socket.request);
        if (!session) return next(new Error('로그인이 필요합니다.'));
        socket.data.session = session;
        next();
    });
    io.on('connection', socket => {
        const session = socket.data.session;
        const userId = session.userId;
        socket.join(`session:${session.key}`);
        let state = online.get(userId);
        if (!state) {
            const result = db.prepare('INSERT INTO visits (user_id, entered_at) VALUES (?, ?)').run(userId, new Date().toISOString());
            state = { sockets: new Set(), visitId: result.lastInsertRowid };
            online.set(userId, state);
        }
        state.sockets.add(socket.id);
        presence();
        socket.on('chat message', (payload, ack) => {
            const respond = typeof ack === 'function' ? ack : () => {};
            if (!sessionFor(socket.request)) {
                respond({ error: '로그인이 만료되었습니다.' });
                socket.disconnect(true);
                return;
            }
            if (!payload || typeof payload.body !== 'string' || !payload.body.trim() || payload.body.length > 4000 ||
                typeof payload.clientId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(payload.clientId)) {
                return respond({ error: '메시지는 1~4,000자로 입력하세요.' });
            }
            try {
                const existing = db.prepare(`SELECT id, user_id AS userId, client_id AS clientId, body, created_at AS createdAt
                    FROM messages WHERE user_id = ? AND client_id = ?`).get(userId, payload.clientId);
                if (existing) return respond({ message: existing });
                const now = Date.now();
                const rate = messageRates.get(userId) || { count: 0, until: now + 10000 };
                if (rate.until <= now) { rate.count = 0; rate.until = now + 10000; }
                messageRates.set(userId, rate);
                if (rate.count >= 20) return respond({ error: '잠시 후 다시 전송하세요.' });
                rate.count++;
                const createdAt = new Date().toISOString();
                const body = payload.body.trim();
                const result = db.prepare('INSERT INTO messages (user_id, client_id, body, created_at) VALUES (?, ?, ?, ?)')
                    .run(userId, payload.clientId, body, createdAt);
                const message = { id: Number(result.lastInsertRowid), userId, clientId: payload.clientId, body, createdAt };
                io.emit('chat message', message);
                respond({ message });
            } catch (error) {
                console.error('메시지 저장 실패:', error.message);
                respond({ error: '저장하지 못했습니다. 다시 시도하세요.' });
            }
        });
        socket.on('disconnect', () => {
            state.sockets.delete(socket.id);
            if (!state.sockets.size) {
                online.delete(userId);
                db.prepare('UPDATE visits SET left_at = ?, end_reason = ? WHERE id = ?')
                    .run(new Date().toISOString(), closing ? 'shutdown' : 'disconnected', state.visitId);
                presence();
            }
        });
    });
    const cleanup = setInterval(() => {
        for (const [key, value] of sessions) if (value.expires <= Date.now()) {
            sessions.delete(key);
            io.in(`session:${key}`).disconnectSockets(true);
        }
        for (const [key, value] of attempts) if (value.until <= Date.now()) attempts.delete(key);
        for (const [key, value] of guestAttempts) if (value.until <= Date.now()) guestAttempts.delete(key);
    }, 30000);
    cleanup.unref();
    async function close() {
        closing = true;
        clearInterval(cleanup);
        await new Promise(resolve => io.close(resolve));
        db.close();
    }
    return { app, server, io, db, close };
}

if (require.main === module) {
    const chat = createChatServer();
    try {
        const hasAccountSetup = ['CHAT_USER1_NAME', 'CHAT_USER1_PASSWORD', 'CHAT_USER2_NAME', 'CHAT_USER2_PASSWORD'].some(key => process.env[key]);
        const hasAccounts = chat.db.prepare('SELECT COUNT(*) AS count FROM users WHERE id > 0').get().count > 0;
        if (process.env.ALLOW_GUESTS === 'false' || hasAccountSetup || hasAccounts) initializeUsers(chat.db);
        const port = process.env.PORT || 3000;
        chat.server.listen(port, '0.0.0.0', () => console.log(`메신저 실행: 포트 ${port}`));
        let stopping = false;
        const stop = () => { if (!stopping) { stopping = true; chat.close(); } };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
    } catch (error) {
        console.error(error.message);
        chat.close();
        process.exitCode = 1;
    }
}
module.exports = { createChatServer };
