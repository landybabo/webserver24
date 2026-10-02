const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');

function openStore(filename = process.env.CHAT_DB || path.join(__dirname, 'data', 'chat.sqlite')) {
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    const db = new DatabaseSync(filename);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY CHECK (id <= 2 AND id != 0),
            name TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            client_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE(user_id, client_id)
        );
        CREATE TABLE IF NOT EXISTS visits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            entered_at TEXT NOT NULL, left_at TEXT, end_reason TEXT
        );
    `);
    // Older databases restricted users to IDs 1 and 2. Negative IDs identify guests.
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get().sql;
    if (schema.includes('id IN (1, 2)')) {
        db.exec('PRAGMA foreign_keys = OFF');
        try {
            db.exec(`BEGIN;
                CREATE TABLE users_new (
                    id INTEGER PRIMARY KEY CHECK (id <= 2 AND id != 0),
                    name TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL
                );
                INSERT INTO users_new SELECT * FROM users;
                DROP TABLE users;
                ALTER TABLE users_new RENAME TO users;
                COMMIT;`);
        } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
        db.exec('PRAGMA foreign_keys = ON');
    }
    return db;
}
function addUser(db, id, name, password) {
    if (![1, 2].includes(id)) throw new Error('등록 계정은 두 개만 사용할 수 있습니다.');
    name = name.trim();
    if (!name || name.length > 24) throw new Error('이름은 1~24자로 입력하세요.');
    if (password.length < 12 || password.length > 128) throw new Error('비밀번호는 12~128자로 입력하세요.');
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    db.prepare('INSERT INTO users (id, name, salt, password_hash) VALUES (?, ?, ?, ?)').run(id, name, salt, hash);
}
function verifyPassword(user, password) {
    const hash = scryptSync(password, user?.salt || 'invalid-user-salt', 64);
    const expected = user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64);
    return timingSafeEqual(hash, expected) && Boolean(user);
}

function initializeUsers(db, env = process.env) {
    const count = db.prepare('SELECT COUNT(*) AS count FROM users WHERE id > 0').get().count;
    if (count === 2) return;
    if (count !== 0) throw new Error('계정 구성이 불완전합니다. 기존 DB를 확인하세요.');
    const keys = ['CHAT_USER1_NAME', 'CHAT_USER1_PASSWORD', 'CHAT_USER2_NAME', 'CHAT_USER2_PASSWORD'];
    if (!keys.every(key => typeof env[key] === 'string' && env[key].length)) {
        throw new Error('npm run setup으로 두 계정을 등록하거나 CHAT_USER1_NAME/PASSWORD, CHAT_USER2_NAME/PASSWORD 환경 변수를 설정하세요.');
    }
    if (env.CHAT_USER1_PASSWORD === env.CHAT_USER2_PASSWORD) throw new Error('두 계정에 서로 다른 비밀번호를 설정하세요.');
    db.exec('BEGIN');
    try {
        addUser(db, 1, env.CHAT_USER1_NAME, env.CHAT_USER1_PASSWORD);
        addUser(db, 2, env.CHAT_USER2_NAME, env.CHAT_USER2_PASSWORD);
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
module.exports = { openStore, addUser, verifyPassword, initializeUsers };
