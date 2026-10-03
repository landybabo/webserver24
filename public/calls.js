/* Audio-only WebRTC. Signaling is scoped to one call by the server. */
class VoiceCalls {
    constructor() {
        this.socket = null; this.current = null; this.config = null; this.people = [];
        this.epoch = 0; this.switching = false;
        this.audio = document.getElementById('call-audio');
        this.el = id => document.getElementById(id);
        this.el('call-start').onclick = () => this.dial();
        this.el('call-accept').onclick = () => this.accept();
        this.el('call-end').onclick = () => this.end();
        this.el('call-mute').onclick = () => {
            const call = this.current;
            if (!call?.stream) return;
            call.muted = !call.muted;
            call.stream.getAudioTracks().forEach(track => { track.enabled = !call.muted; });
            this.el('call-mute').textContent = call.muted ? '마이크 켜기' : '음소거';
            this.el('call-mute').setAttribute('aria-pressed', String(call.muted));
        };
        this.el('call-play').onclick = () => this.play();
        this.el('call-mic').onchange = () => this.switchMicrophone();
        this.el('call-output').onchange = async () => {
            try { await this.audio.setSinkId(this.el('call-output').value); }
            catch { this.error('출력을 바꾸지 못했어요. 기기의 소리 설정에서 헤드셋을 선택하세요.'); }
        };
        this.el('call-output-picker').onclick = async () => {
            try {
                const device = await navigator.mediaDevices.selectAudioOutput();
                await this.audio.setSinkId(device.deviceId);
                await this.devices();
                this.el('call-output').value = device.deviceId;
            } catch { this.error('기기의 소리 설정에서 헤드셋을 선택하거나 다시 시도하세요.'); }
        };
        navigator.mediaDevices?.addEventListener('devicechange', () => this.devices());
        window.addEventListener('pagehide', () => this.end());
    }
    error(message) { this.el('call-error').textContent = message; }
    status(message) { this.el('call-status').textContent = message; }
    async attach(socket, user) {
        this.reset(); this.socket = socket; this.user = user; this.config = null;
        const epoch = ++this.epoch;
        socket.on('call:incoming', data => {
            if (this.current) { socket.emit('call:end', { id: data.id }); return; }
            this.current = { id: data.id, name: data.name, role: 'callee', phase: 'ringing', candidates: [], chain: Promise.resolve() };
            this.error(''); this.status(`${data.name}님의 전화가 왔어요`); this.render();
            this.el('call-accept').focus();
        });
        socket.on('call:accepted', data => {
            const call = this.current;
            if (call?.id !== data.id || call.role !== 'caller') return;
            call.phase = 'connecting'; this.status('음성을 연결하고 있어요…'); this.render();
            this.offer(call).catch(error => this.fail(call, error));
        });
        socket.on('call:signal', data => {
            const call = this.current;
            if (call?.id !== data.id) return;
            call.chain = call.chain.then(() => this.signal(call, data)).catch(error => this.fail(call, error));
        });
        socket.on('call:ended', data => {
            if (this.current?.id !== data.id) return;
            const reasons = { 'declined': '상대방이 전화를 거절했어요.', 'no-answer': '상대방이 응답하지 않았어요.', 'answered-elsewhere': '다른 창에서 전화를 받았어요.', 'connection-timeout': '음성을 연결하지 못했어요. 네트워크와 중계 서버 설정을 확인하세요.', 'disconnected': '상대방 또는 서버와 연결이 끊어졌어요.', 'failed': '통화 연결에 실패했어요.' };
            this.reset(reasons[data.reason] || '통화가 종료되었습니다.');
        });
        socket.on('disconnect', () => this.reset('서버 연결이 끊겨 통화가 종료되었습니다.'));
        socket.on('connect', () => this.render());
        this.status('통화 설정 확인 중…'); this.render();
        try {
            const response = await fetch('/api/calls/config', { signal: AbortSignal.timeout(12000), credentials: 'same-origin' });
            if (!response.ok) throw new Error('통화 설정을 불러오지 못했어요. 다시 로그인해 주세요.');
            const config = await response.json();
            if (epoch !== this.epoch) return;
            this.config = config;
            const supported = Boolean(window.isSecureContext && window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia);
            if (!supported) { this.config.enabled = false; this.status('HTTPS 주소와 음성 통화를 지원하는 브라우저가 필요해요.'); }
            else this.status(config.enabled ? (config.relayConfigured ? '해외 음성 통화 준비됨' : '직접 연결 테스트 모드 · 일부 네트워크에서 연결되지 않아요') : '통화 준비 중 · 서버에 TURN 중계 설정이 필요해요');
            this.render();
        } catch (error) { if (epoch === this.epoch) { this.error(error.message); this.status('통화 설정을 확인하지 못했어요.'); } }
    }
    detach() { this.end(); this.epoch++; this.socket = null; this.config = null; this.render(); }
    setPeople(people) {
        this.people = people;
        const select = this.el('call-peer'); const previous = select.value;
        select.replaceChildren(new Option('통화할 상대 선택', ''));
        for (const person of people) if (person.id !== this.user?.id && person.online) select.add(new Option(person.name, String(person.id)));
        if ([...select.options].some(option => option.value === previous)) select.value = previous;
        else if (select.options.length === 2) select.selectedIndex = 1;
        this.render();
    }
    render() {
        const call = this.current;
        const active = Boolean(call);
        this.el('call-start').disabled = active || !this.socket?.connected || !this.config?.enabled;
        this.el('call-peer').disabled = active;
        this.el('call-accept').hidden = !(call?.role === 'callee' && call.phase === 'ringing');
        this.el('call-end').hidden = !active;
        this.el('call-end').textContent = call?.phase === 'ringing' && call.role === 'callee' ? '거절' : '통화 종료';
        this.el('call-mute').hidden = !call?.stream;
        this.el('call-devices').hidden = !call?.stream;
        this.el('call-panel').dataset.state = call?.phase || 'idle';
    }
    request(event, data) {
        return new Promise((resolve, reject) => {
            if (!this.socket?.connected) return reject(new Error('서버 연결을 확인해 주세요.'));
            this.socket.timeout(8000).emit(event, data, (error, result) => {
                if (error || result?.error || !result) reject(new Error(result?.error || '통화 요청 응답이 없어요. 다시 시도하세요.'));
                else resolve(result);
            });
        });
    }
    async microphone(call) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (this.current !== call) { stream.getTracks().forEach(track => track.stop()); return false; }
        call.stream = stream; call.muted = false;
        stream.getAudioTracks().forEach(track => { track.onended = () => this.fail(call, new Error('마이크 연결이 끊어졌어요. 헤드셋을 연결한 뒤 다시 전화하세요.')); });
        this.render(); await this.devices();
        // Obtain fresh relay credentials even if the chat page has been open all day.
        const response = await fetch('/api/calls/config', { signal: AbortSignal.timeout(12000), credentials: 'same-origin' });
        if (!response.ok) throw new Error('통화 설정을 불러오지 못했어요. 다시 로그인해 주세요.');
        const config = await response.json();
        if (this.current !== call) return false;
        if (!config.enabled) throw new Error('해외 통화를 위한 중계 서버 설정이 필요합니다.');
        this.config = config;
        return true;
    }
    async dial() {
        if (this.current || !this.config?.enabled) return;
        const peer = this.people.find(person => String(person.id) === this.el('call-peer').value && person.online);
        if (!peer) { this.error('접속한 상대를 선택하세요.'); return; }
        const call = { role: 'caller', name: peer.name, phase: 'preparing', candidates: [], chain: Promise.resolve() };
        this.current = call; this.error(''); this.status('마이크 사용을 허용해 주세요.'); this.render();
        try {
            if (!await this.microphone(call)) return;
            this.peerConnection(call);
            const result = await this.request('call:request', { userId: peer.id });
            if (this.current !== call) { this.socket?.emit('call:end', { id: result.id }); return; }
            call.id = result.id; call.phase = 'ringing';
            this.status(`${peer.name}님의 응답을 기다리고 있어요…`); this.render();
        } catch (error) { this.fail(call, error); }
    }
    async accept() {
        const call = this.current;
        if (!call || call.phase !== 'ringing') return;
        call.phase = 'preparing'; this.error(''); this.status('마이크 사용을 허용해 주세요.'); this.render();
        // Playback is attempted in the user gesture; a visible retry handles autoplay restrictions.
        this.audio.play().catch(() => {});
        try {
            if (!await this.microphone(call)) return;
            this.peerConnection(call);
            await this.request('call:accept', { id: call.id });
            if (this.current !== call) return;
            call.phase = 'connecting'; this.status('음성을 연결하고 있어요…'); this.render();
        } catch (error) { this.fail(call, error); }
    }
    peerConnection(call) {
        const pc = new RTCPeerConnection({ iceServers: this.config.iceServers, iceTransportPolicy: this.config.iceTransportPolicy });
        call.pc = pc;
        call.stream.getTracks().forEach(track => pc.addTrack(track, call.stream));
        pc.onicecandidate = event => {
            if (event.candidate && this.current === call && call.id) this.request('call:signal', { id: call.id, candidate: event.candidate.toJSON() }).catch(error => this.fail(call, error));
        };
        pc.ontrack = event => {
            if (this.current !== call) return;
            this.audio.srcObject = event.streams[0] || new MediaStream([event.track]);
            this.play();
        };
        pc.onconnectionstatechange = () => {
            if (this.current !== call) return;
            if (pc.connectionState === 'connected') {
                clearTimeout(call.disconnectTimer);
                call.phase = 'active'; call.startedAt ||= Date.now();
                const update = () => {
                    const seconds = Math.floor((Date.now() - call.startedAt) / 1000);
                    this.status(`${call.name} · 통화 중 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
                };
                clearInterval(call.clock); update(); call.clock = setInterval(update, 1000);
                this.request('call:connected', { id: call.id }).catch(error => this.fail(call, error)); this.render();
            } else if (pc.connectionState === 'failed') this.fail(call, new Error('음성 연결에 실패했어요. 네트워크나 중계 서버 설정을 확인하고 다시 전화하세요.'));
            else if (pc.connectionState === 'disconnected') {
                clearInterval(call.clock); this.status('음성 연결 복구를 기다리는 중…');
                clearTimeout(call.disconnectTimer);
                call.disconnectTimer = setTimeout(() => this.fail(call, new Error('음성 연결이 끊어졌어요. 다시 전화해 주세요.')), 15000);
            }
        };
    }
    async offer(call) {
        const offer = await call.pc.createOffer();
        if (this.current !== call) return;
        await call.pc.setLocalDescription(offer);
        if (this.current === call) await this.request('call:signal', { id: call.id, description: { type: offer.type, sdp: offer.sdp } });
    }
    async signal(call, data) {
        if (this.current !== call) return;
        if (data.candidate) {
            if (call.pc?.remoteDescription) await call.pc.addIceCandidate(data.candidate);
            else call.candidates.push(data.candidate);
            return;
        }
        if (!data.description || !call.pc) return;
        await call.pc.setRemoteDescription(data.description);
        if (this.current !== call) return;
        for (const candidate of call.candidates.splice(0)) await call.pc.addIceCandidate(candidate);
        if (data.description.type === 'offer') {
            const answer = await call.pc.createAnswer();
            if (this.current !== call) return;
            await call.pc.setLocalDescription(answer);
            if (this.current === call) await this.request('call:signal', { id: call.id, description: { type: answer.type, sdp: answer.sdp } });
        }
    }
    async play() {
        try { await this.audio.play(); this.el('call-play').hidden = true; }
        catch { if (this.current) this.el('call-play').hidden = false; }
    }
    async devices() {
        if (!this.current?.stream) return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const micId = this.current?.stream?.getAudioTracks()[0]?.getSettings().deviceId;
            for (const [id, kind, selected] of [['call-mic', 'audioinput', micId], ['call-output', 'audiooutput', this.audio.sinkId]]) {
                const select = this.el(id); select.replaceChildren(new Option('기기 기본 장치', ''));
                devices.filter(device => device.kind === kind).forEach((device, index) => select.add(new Option(device.label || `장치 ${index + 1}`, device.deviceId)));
                if ([...select.options].some(option => option.value === selected)) select.value = selected;
            }
            this.el('call-output-row').hidden = typeof this.audio.setSinkId !== 'function';
            this.el('call-output-picker').hidden = !(navigator.mediaDevices.selectAudioOutput && this.audio.setSinkId);
        } catch { this.error('장치 목록을 확인하지 못했어요. 기기의 오디오 설정을 사용하세요.'); }
    }
    async switchMicrophone() {
        const call = this.current;
        if (!call?.pc || this.switching) return;
        this.switching = true;
        let stream;
        try {
            const id = this.el('call-mic').value;
            stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: true, noiseSuppression: true } });
            if (this.current !== call) { stream.getTracks().forEach(track => track.stop()); return; }
            const track = stream.getAudioTracks()[0]; track.enabled = !call.muted;
            await call.pc.getSenders().find(sender => sender.track?.kind === 'audio').replaceTrack(track);
            if (this.current !== call) { stream.getTracks().forEach(item => item.stop()); return; }
            call.stream.getTracks().forEach(old => old.stop()); call.stream = stream;
            track.onended = () => this.fail(call, new Error('마이크 연결이 끊어졌어요. 다시 전화해 주세요.'));
            this.error('');
        } catch { stream?.getTracks().forEach(track => track.stop()); this.error('마이크를 바꾸지 못했어요. 기존 마이크를 사용합니다.'); }
        finally { this.switching = false; await this.devices(); }
    }
    fail(call, error) {
        if (this.current !== call) return;
        this.end();
        this.error(error.name === 'NotAllowedError' ? '마이크 권한을 허용한 뒤 다시 전화해 주세요.' : error.name === 'NotFoundError' ? '마이크가 없어요. 헤드셋을 연결해 주세요.' : error.message);
    }
    end() {
        const call = this.current;
        if (call && this.socket?.connected) this.socket.emit(call.id ? 'call:end' : 'call:cancel', { id: call.id });
        this.reset();
    }
    reset(message = '통화가 종료되었습니다.') {
        const call = this.current; this.current = null;
        if (call) {
            clearInterval(call.clock); clearTimeout(call.disconnectTimer);
            call.pc?.close(); call.stream?.getTracks().forEach(track => track.stop());
        }
        this.audio.pause(); this.audio.srcObject = null;
        this.el('call-play').hidden = true;
        this.el('call-mute').textContent = '음소거'; this.el('call-mute').setAttribute('aria-pressed', 'false');
        this.status(message); this.render();
    }
}
window.VoiceCalls = VoiceCalls;
