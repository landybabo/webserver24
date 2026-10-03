const $ = id => document.getElementById(id);
let me = null;
let socket = null;
let people = [];
let messages = new Map();
let visits = [];
let sending = false;
let pending = null;
let generation = 0;
let visitsRequest = 0;
let historyLoading = false;
let guestEnabled = false;
const voiceCalls = new VoiceCalls();
const dateFormat = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const date = value => value ? dateFormat.format(new Date(value)) : '기록 없음';
function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' });
    const result = await response.json();
    if (!response.ok) {
        if (response.status === 401 && url !== '/api/login') showLogin('다시 로그인해 주세요.');
        throw new Error(result.error || '요청에 실패했습니다.');
    }
    return result;
}
function showLogin(error = '') {
    generation++;
    voiceCalls.detach();
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
    me = null; people = []; messages.clear(); visits = []; pending = null; sending = false; historyLoading = false;
    $('messages').replaceChildren(); $('people').replaceChildren(); $('visits').replaceChildren();
    $('message-input').value = ''; $('character-count').textContent = '0 / 4,000';
    $('new-message').hidden = true; $('chat-error').textContent = '';
    $('chat-view').hidden = true; $('login-view').hidden = false;
    $('login-error').textContent = error;
}
function renderPeople() {
    voiceCalls.setPeople(people);
    $('people').replaceChildren(...people.map(user => {
        const card = element('div', undefined, `person${user.online ? ' online' : ''}`);
        const top = element('div', undefined, 'person-top');
        top.append(element('span', undefined, 'dot'), element('strong', `${user.name}${user.id === me.id ? ' (나)' : ''}`), element('span', user.online === null ? '확인 중' : user.online ? '접속 중' : '오프라인', 'person-status'));
        card.append(top, element('p', `최근 입장: ${date(user.lastEnteredAt)}\n${user.online === null ? '재연결 후 상태를 확인합니다' : user.online ? '지금 대화방에 있어요' : user.lastEndReason === 'interrupted' ? '연결 종료 시각 확인 불가' : `최근 퇴장: ${date(user.lastLeftAt)}`}`));
        return card;
    }));
    const other = people.find(user => user.id !== me.id);
    $('chat-title').textContent = guestEnabled ? '우리의 대화' : other ? `${other.name}님과의 대화` : '우리의 대화';
}
function scrollBottom() {
    $('message-scroll').scrollTop = $('message-scroll').scrollHeight;
    $('new-message').hidden = true;
}
function renderMessages() {
    const nodes = [...messages.values()].sort((a, b) => a.id - b.id).map(message => {
        const item = element('li', undefined, `message${message.userId === me.id ? ' mine' : ''}`);
        const name = people.find(user => user.id === message.userId)?.name || '참여자';
        const meta = element('div', undefined, 'message-meta');
        const time = element('time', date(message.createdAt));
        time.dateTime = message.createdAt; time.title = new Date(message.createdAt).toLocaleString('ko-KR');
        meta.append(document.createTextNode(`${name} · `), time);
        item.append(meta, element('div', message.body, 'bubble'));
        return item;
    });
    $('messages').replaceChildren(...nodes);
    $('empty').hidden = messages.size > 0;
}
function receiveMessage(message) {
    if (messages.has(message.id)) return;
    const area = $('message-scroll');
    const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 90;
    messages.set(message.id, message); renderMessages();
    if (atBottom || message.userId === me.id) scrollBottom();
    else $('new-message').hidden = false;
}
async function loadMessages(older = false) {
    if (historyLoading) return;
    historyLoading = true;
    const current = generation;
    const area = $('message-scroll');
    const beforeHeight = area.scrollHeight;
    const beforeTop = area.scrollTop;
    $('older-messages').disabled = true;
    try {
        const ids = [...messages.keys()];
        const before = older && ids.length ? `?before=${Math.min(...ids)}` : '';
        const data = await api(`/api/messages${before}`);
        if (current !== generation) return;
        // Reconnect loads a fresh contiguous page so offline gaps cannot be skipped.
        if (!older) {
            const newest = data.messages.at(-1)?.id || 0;
            messages = new Map([...messages].filter(([id]) => id > newest));
        }
        for (const message of data.messages) messages.set(message.id, message);
        $('older-messages').hidden = !data.hasMore;
        renderMessages();
        if (older) area.scrollTop = beforeTop + area.scrollHeight - beforeHeight;
        else scrollBottom();
    } finally { if (current === generation) { historyLoading = false; $('older-messages').disabled = false; } }
}
async function loadVisits(older = false) {
    const current = generation;
    const request = ++visitsRequest;
    $('older-visits').disabled = true;
    try {
        const before = older && visits.length ? `?before=${visits[visits.length - 1].id}` : '';
        const data = await api(`/api/visits${before}`);
        if (current !== generation || request !== visitsRequest) return;
        visits = older ? [...visits, ...data.visits] : data.visits;
        $('older-visits').hidden = !data.hasMore;
        $('visits').replaceChildren(...visits.map(visit => {
            const item = element('li');
            const end = visit.endReason === 'interrupted' ? '종료 시각 미확인 (서버 연결 중단)' : visit.leftAt ? `퇴장 ${date(visit.leftAt)}${visit.endReason === 'shutdown' ? ' · 서버 종료' : ''}` : '현재 접속 중';
            item.append(element('strong', visit.name), element('p', `입장 ${date(visit.enteredAt)} · ${end}`));
            return item;
        }));
    } finally { if (current === generation && request === visitsRequest) $('older-visits').disabled = false; }
}
function report(error) { if (me) $('chat-error').textContent = error.message; }
function updateSend() { $('send').disabled = !socket?.connected || sending; }
function startChat(user) {
    me = user;
    $('login-view').hidden = true; $('chat-view').hidden = false;
    $('password').value = ''; $('my-name').textContent = `${me.name} · 나`;
    $('connection').textContent = '연결 중'; $('connection').className = 'connection';
    socket = io({ autoConnect: false });
    voiceCalls.attach(socket, me);
    socket.on('presence', data => { people = data; renderPeople(); renderMessages(); loadVisits().catch(report); });
    socket.on('chat message', receiveMessage);
    socket.on('connect', () => {
        $('connection').textContent = '실시간 연결됨'; $('connection').className = 'connection connected';
        $('chat-error').textContent = ''; updateSend();
        loadMessages().catch(report);
    });
    socket.on('disconnect', reason => {
        $('connection').textContent = '연결 끊김 · 재연결 중'; $('connection').className = 'connection'; updateSend();
        people = people.map(user => ({ ...user, online: null })); renderPeople();
        if (reason === 'io server disconnect') showLogin('세션이 종료되었습니다. 다시 로그인해 주세요.');
    });
    socket.on('connect_error', error => {
        if (error.message === '로그인이 필요합니다.') showLogin('다시 로그인해 주세요.');
        else { $('connection').textContent = '연결 재시도 중'; updateSend(); }
    });
    updateSend(); socket.connect();
}
$('login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('login-button').disabled = true; $('guest-button').disabled = true; $('login-error').textContent = '';
    try {
        const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ name: $('name').value, password: $('password').value }) });
        startChat(data.user);
    } catch (error) { $('login-error').textContent = error.message; }
    finally { $('login-button').disabled = false; $('guest-button').disabled = false; }
});
$('guest-button').addEventListener('click', async () => {
    $('guest-button').disabled = true; $('login-button').disabled = true; $('login-error').textContent = '';
    try {
        const data = await api('/api/guest', { method: 'POST', body: '{}' });
        startChat(data.user);
    } catch (error) { $('login-error').textContent = error.message; }
    finally { $('guest-button').disabled = false; $('login-button').disabled = false; }
});
$('logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: '{}' }); showLogin(); }
    catch (error) { report(error); }
});
$('message-form').addEventListener('submit', event => {
    event.preventDefault();
    const body = $('message-input').value;
    if (!body.trim() || sending || !socket?.connected) return;
    if (!pending || pending.body !== body) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        pending = { body, clientId: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') };
    }
    sending = true; updateSend(); $('chat-error').textContent = '';
    const current = generation;
    socket.timeout(8000).emit('chat message', pending, (error, result) => {
        if (current !== generation) return;
        sending = false; updateSend();
        if (error || result?.error || !result?.message) {
            $('chat-error').textContent = error ? '전송 확인을 받지 못했어요. 다시 보내기를 누르면 중복 없이 확인합니다.' : result?.error || '전송하지 못했습니다.';
            return;
        }
        receiveMessage(result.message); pending = null;
        if ($('message-input').value === body) { $('message-input').value = ''; $('character-count').textContent = '0 / 4,000'; }
        $('message-input').focus();
    });
});
$('message-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('message-form').requestSubmit(); }
});
$('message-input').addEventListener('input', () => { $('character-count').textContent = `${$('message-input').value.length.toLocaleString()} / 4,000`; });
$('older-messages').addEventListener('click', () => loadMessages(true).catch(report));
$('older-visits').addEventListener('click', () => loadVisits(true).catch(report));
$('refresh-visits').addEventListener('click', () => loadVisits().catch(report));
$('new-message').addEventListener('click', scrollBottom);
$('message-scroll').addEventListener('scroll', () => {
    const area = $('message-scroll');
    if (area.scrollHeight - area.scrollTop - area.clientHeight < 90) $('new-message').hidden = true;
});
async function initialize() {
    $('login-button').disabled = true;
    $('guest-button').disabled = true;
    try {
        const config = await api('/api/config');
        guestEnabled = config.guestEnabled;
        $('guest-button').hidden = !guestEnabled;
        $('access-notice').textContent = guestEnabled ? '입력 없이 자동 이름으로 입장해요. 주소를 아는 누구나 대화와 접속 기록을 볼 수 있어요.' : '등록된 두 계정만 입장할 수 있어요.';
        $('room-badge').textContent = guestEnabled ? '게스트 허용' : '1:1';
        if (guestEnabled) $('room-notice').textContent = '게스트 입장 허용 중 · 입장한 누구나 이전 대화와 접속 기록을 볼 수 있어요.';
        const data = await api('/api/me');
        startChat(data.user);
    } catch (error) { $('login-error').textContent = error.message === '로그인이 필요합니다.' ? '' : error.message; }
    finally { $('login-button').disabled = false; $('guest-button').disabled = false; }
}
initialize();
