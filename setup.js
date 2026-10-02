const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const { openStore, addUser } = require('./store');

async function setup() {
    const db = openStore();
    let muted = false;
    const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
    const input = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
    try {
        if (db.prepare('SELECT COUNT(*) AS count FROM users WHERE id > 0').get().count) throw new Error('계정이 이미 등록되어 있습니다. 기존 데이터는 유지됩니다.');
        console.log('두 사람의 계정을 등록합니다. 비밀번호는 12자 이상이며 화면에 표시되지 않습니다.');
        const users = [];
        for (const id of [1, 2]) {
            const name = await input.question(`${id}번 사용자 이름: `);
            process.stdout.write(`${id}번 비밀번호: `);
            muted = true;
            const password = await input.question('');
            muted = false;
            process.stdout.write('\n비밀번호 확인: ');
            muted = true;
            const confirmation = await input.question('');
            muted = false;
            process.stdout.write('\n');
            if (password !== confirmation) throw new Error('비밀번호가 일치하지 않습니다. 다시 실행하세요.');
            users.push({ id, name, password });
        }
        db.exec('BEGIN');
        try {
            for (const user of users) addUser(db, user.id, user.name, user.password);
            db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        console.log('등록 완료. npm start로 실행하세요.');
    } finally { input.close(); db.close(); }
}
setup().catch(error => { console.error(error.message); process.exitCode = 1; });
