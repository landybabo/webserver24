const { randomUUID, createHmac } = require('node:crypto');

function callConfiguration(env, userId) {
    const urls = (env.TURN_URLS || '').split(',').map(url => url.trim()).filter(Boolean);
    const valid = urls.length > 0 && urls.every(url => /^turns?:[^\s/]+(?::\d+)?(?:\?transport=(udp|tcp))?$/.test(url));
    const relayConfigured = Boolean(valid && (env.TURN_SHARED_SECRET || (env.TURN_USERNAME && env.TURN_PASSWORD)));
    const enabled = relayConfigured || env.CALL_ALLOW_DIRECT === 'true';
    const iceServers = [];
    if (relayConfigured) {
        const username = env.TURN_SHARED_SECRET ? `${Math.floor(Date.now() / 1000) + 86400}:${userId}` : env.TURN_USERNAME;
        const credential = env.TURN_SHARED_SECRET ? createHmac('sha1', env.TURN_SHARED_SECRET).update(username).digest('base64') : env.TURN_PASSWORD;
        iceServers.push({ urls, username, credential });
    }
    return { enabled, relayConfigured, iceServers, iceTransportPolicy: relayConfigured ? 'relay' : 'all' };
}

function installCalls({ io, app, requireAuth, sessionFor, db, env = process.env, ringMs = 45000, connectMs = 45000 }) {
    const calls = new Map();
    const occupied = new Map();
    const lastDial = new Map();
    app.get('/api/calls/config', requireAuth, (req, res) => res.json(callConfiguration(env, req.session.userId)));
    function targets(userId) {
        return [...io.sockets.sockets.values()].filter(socket => socket.data.session?.userId === userId && sessionFor(socket.request));
    }
    function finish(call, reason) {
        if (!calls.delete(call.id)) return;
        clearTimeout(call.timer);
        occupied.delete(call.from); occupied.delete(call.to);
        const ids = new Set([call.caller, ...call.invited]);
        for (const id of ids) io.to(id).emit('call:ended', { id: call.id, reason });
    }
    function arm(call, delay, reason) {
        clearTimeout(call.timer);
        call.timer = setTimeout(() => finish(call, reason), delay);
        call.timer.unref();
    }
    io.on('connection', socket => {
        const userId = socket.data.session.userId;
        function listen(event, action) {
            socket.on(event, (data, ack) => {
                const reply = typeof ack === 'function' ? ack : () => {};
                if (!sessionFor(socket.request)) { reply({ error: '로그인이 만료되었습니다.' }); socket.disconnect(true); return; }
                try { action(data || {}, reply); }
                catch { reply({ error: '통화 요청을 처리하지 못했습니다.' }); }
            });
        }
        function bound(data) {
            const call = calls.get(data.id);
            return call && (call.caller === socket.id || call.callee === socket.id) ? call : null;
        }
        listen('call:request', (data, reply) => {
            if (!callConfiguration(env, userId).enabled) return reply({ error: '해외 통화를 위한 중계 서버 설정이 필요합니다.' });
            if (!Number.isSafeInteger(data.userId) || data.userId === userId) return reply({ error: '통화할 상대를 선택하세요.' });
            if (occupied.has(userId) || occupied.has(data.userId)) return reply({ error: '이미 통화 중이거나 다른 전화에 응답 중입니다.' });
            const peers = targets(data.userId);
            if (!peers.length) return reply({ error: '상대방이 오프라인입니다.' });
            if (Date.now() - (lastDial.get(userId) || 0) < 3000) return reply({ error: '잠시 후 다시 전화하세요.' });
            lastDial.set(userId, Date.now());
            const call = { id: randomUUID(), from: userId, to: data.userId, caller: socket.id, callee: null, invited: peers.map(peer => peer.id), state: 'ringing', connected: new Set(), signals: 0 };
            calls.set(call.id, call); occupied.set(userId, call.id); occupied.set(data.userId, call.id);
            arm(call, ringMs, 'no-answer');
            reply({ id: call.id });
            const name = db.prepare('SELECT name FROM users WHERE id = ?').get(userId).name;
            for (const peer of peers) peer.emit('call:incoming', { id: call.id, userId, name });
        });
        listen('call:accept', (data, reply) => {
            const call = calls.get(data.id);
            if (!call || call.state !== 'ringing' || call.to !== userId || !call.invited.includes(socket.id)) return reply({ error: '이미 종료되었거나 다른 창에서 받은 전화입니다.' });
            const caller = io.sockets.sockets.get(call.caller);
            if (!caller || !sessionFor(caller.request)) { finish(call, 'disconnected'); return reply({ error: '상대방의 연결이 종료되었습니다.' }); }
            call.callee = socket.id; call.state = 'connecting';
            arm(call, connectMs, 'connection-timeout');
            reply({ ok: true });
            io.to(call.caller).emit('call:accepted', { id: call.id });
            for (const id of call.invited) if (id !== socket.id) io.to(id).emit('call:ended', { id: call.id, reason: 'answered-elsewhere' });
        });
        listen('call:end', (data, reply) => {
            const call = calls.get(data.id);
            if (!call || !(bound(data) || (call.state === 'ringing' && call.to === userId && call.invited.includes(socket.id)))) return reply({ error: '이 통화에 접근할 수 없습니다.' });
            finish(call, call.state === 'ringing' && userId === call.to ? 'declined' : 'ended');
            reply({ ok: true });
        });
        listen('call:cancel', (data, reply) => {
            const call = calls.get(occupied.get(userId));
            if (call?.caller === socket.id) finish(call, 'ended');
            reply({ ok: true });
        });
        listen('call:signal', (data, reply) => {
            const call = bound(data);
            if (!call || call.state === 'ringing') return reply({ error: '연결할 통화가 없습니다.' });
            const peerId = socket.id === call.caller ? call.callee : call.caller;
            const peer = io.sockets.sockets.get(peerId);
            if (!peer || !sessionFor(peer.request)) { finish(call, 'disconnected'); return reply({ error: '상대방의 연결이 종료되었습니다.' }); }
            const description = data.description;
            const candidate = data.candidate;
            let signal;
            if (description && ['offer', 'answer'].includes(description.type) && typeof description.sdp === 'string' && description.sdp.length <= 12000) {
                if ((description.type === 'offer') !== (socket.id === call.caller)) return reply({ error: '잘못된 통화 신호입니다.' });
                signal = { description: { type: description.type, sdp: description.sdp } };
            } else if (candidate && typeof candidate.candidate === 'string' && candidate.candidate.length <= 3000 &&
                (candidate.sdpMid === null || typeof candidate.sdpMid === 'string' && candidate.sdpMid.length < 100) &&
                (candidate.sdpMLineIndex === null || Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex < 20)) {
                signal = { candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex } };
            } else return reply({ error: '잘못된 통화 신호입니다.' });
            if (++call.signals > 300) { finish(call, 'failed'); return reply({ error: '통화 신호가 너무 많습니다.' }); }
            io.to(peerId).emit('call:signal', { id: call.id, ...signal });
            reply({ ok: true });
        });
        listen('call:connected', (data, reply) => {
            const call = bound(data);
            if (!call || call.state === 'ringing') return reply({ error: '연결할 통화가 없습니다.' });
            call.connected.add(socket.id);
            if (call.connected.size === 2) { call.state = 'active'; clearTimeout(call.timer); }
            reply({ ok: true });
        });
        socket.on('disconnect', () => {
            const call = calls.get(occupied.get(userId));
            if (call && (call.caller === socket.id || call.callee === socket.id ||
                call.state === 'ringing' && !call.invited.some(id => id !== socket.id && io.sockets.sockets.has(id)))) finish(call, 'disconnected');
            if (!targets(userId).length) lastDial.delete(userId);
        });
    });
    return () => { for (const call of calls.values()) finish(call, 'disconnected'); };
}
module.exports = { installCalls, callConfiguration };
