// Optional Windows browser smoke check. Uses installed Edge, no browser download.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatServer } = require('../server');
const { addUser } = require('../store');

async function main() {
    const chat = createChatServer({ dbPath: ':memory:', secureCookies: false });
    addUser(chat.db, 1, '테스트하나', 'browser-test-password');
    addUser(chat.db, 2, '테스트둘', 'browser-test-password');
    chat.server.listen(0, '127.0.0.1');
    await once(chat.server, 'listening');
    const url = `http://127.0.0.1:${chat.server.address().port}`;
    const profile = mkdtempSync(path.join(os.tmpdir(), 'webchat-browser-'));
    const browser = spawn(process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
        '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let ws;
    try {
        const address = await new Promise((resolve, reject) => {
            let output = '';
            const timer = setTimeout(() => reject(new Error('Edge did not expose DevTools')), 15000);
            browser.once('error', error => { clearTimeout(timer); reject(error); });
            browser.stderr.on('data', chunk => {
                output += chunk;
                const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                if (match) { clearTimeout(timer); resolve(match[1]); }
            });
        });
        ws = new WebSocket(address);
        await once(ws, 'open');
        let id = 0;
        const requests = new Map();
        const errors = [];
        ws.addEventListener('message', event => {
            const packet = JSON.parse(event.data);
            if (packet.id) {
                const task = requests.get(packet.id);
                if (!task) return;
                requests.delete(packet.id);
                clearTimeout(task.timer);
                if (packet.error) task.reject(new Error(packet.error.message)); else task.resolve(packet.result);
            } else if (packet.method === 'Runtime.exceptionThrown') errors.push(packet.params.exceptionDetails.text);
        });
        function call(method, params = {}, sessionId) {
            return new Promise((resolve, reject) => {
                const requestId = ++id;
                const timer = setTimeout(() => { requests.delete(requestId); reject(new Error(`Timeout: ${method}`)); }, 15000);
                requests.set(requestId, { resolve, reject, timer });
                ws.send(JSON.stringify({ id: requestId, method, params, sessionId }));
            });
        }
        async function evaluate(session, expression) {
            const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
            if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
        }
        async function waitFor(session, expression) {
            await evaluate(session, `new Promise((resolve, reject) => { const end = Date.now() + 8000; const check = () => { if (${expression}) resolve(true); else if (Date.now() > end) reject(new Error('UI condition timed out')); else setTimeout(check, 50); }; check(); })`);
        }
        async function page(name, width) {
            const { browserContextId } = await call('Target.createBrowserContext');
            const { targetId } = await call('Target.createTarget', { url: 'about:blank', browserContextId });
            const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
            await call('Runtime.enable', {}, sessionId);
            await call('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width < 500 }, sessionId);
            await call('Page.navigate', { url }, sessionId);
            await waitFor(sessionId, "document.getElementById('login-button') && !document.getElementById('login-button').disabled && typeof io === 'function'");
            if (name) await evaluate(sessionId, `document.getElementById('name').value = ${JSON.stringify(name)}; document.getElementById('password').value = 'browser-test-password'; document.getElementById('login-form').requestSubmit();`);
            else await evaluate(sessionId, "document.getElementById('guest-button').click()");
            await waitFor(sessionId, "document.getElementById('connection').textContent === '실시간 연결됨' && document.querySelectorAll('.person').length >= 2");
            return sessionId;
        }
        const desktop = await page('테스트하나', 1280);
        const mobile = await page('테스트둘', 390);
        await evaluate(desktop, "document.getElementById('message-input').value = '<img src=x onerror=alert(1)> 브라우저 확인'; document.getElementById('message-form').requestSubmit();");
        await waitFor(mobile, "document.querySelectorAll('.bubble').length === 1");
        assert.equal(await evaluate(mobile, "document.querySelector('.bubble').textContent"), '<img src=x onerror=alert(1)> 브라우저 확인');
        assert.equal(await evaluate(mobile, "document.querySelector('.bubble img') === null"), true);
        assert.equal(await evaluate(mobile, 'document.documentElement.scrollWidth <= window.innerWidth'), true);
        assert.equal(await evaluate(desktop, "document.querySelectorAll('.person.online').length"), 2);
        await call('Page.reload', {}, mobile);
        await waitFor(mobile, "document.querySelectorAll('.bubble').length === 1 && document.getElementById('connection').textContent === '실시간 연결됨'");
        await evaluate(mobile, "document.getElementById('logout').click()");
        await waitFor(mobile, "document.getElementById('chat-view').hidden");
        await waitFor(desktop, "document.querySelectorAll('.person.online').length === 1");
        const guest = await page(null, 390);
        assert.match(await evaluate(guest, "document.getElementById('my-name').textContent"), /게스트/);
        await evaluate(guest, "document.getElementById('message-input').value = '입력 없이 입장한 게스트'; document.getElementById('message-form').requestSubmit();");
        await waitFor(desktop, "Array.from(document.querySelectorAll('.bubble')).some(node => node.textContent === '입력 없이 입장한 게스트')");
        await call('Page.reload', {}, guest);
        await waitFor(guest, "document.getElementById('connection').textContent === '실시간 연결됨' && document.getElementById('my-name').textContent.includes('게스트')");
        assert.deepEqual(errors, []);
        console.log('PASS: desktop/mobile login, live delivery, safe text rendering, reload history, presence, logout, one-click guest entry and guest reload; no browser exceptions.');
        const exited = once(browser, 'exit');
        await call('Browser.close');
        if (browser.exitCode === null) await exited;
    } finally {
        ws?.close();
        if (browser.exitCode === null) { const exited = once(browser, 'exit'); browser.kill(); await exited.catch(() => {}); }
        await chat.close();
        assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('webchat-browser-'));
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
