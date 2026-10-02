const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openStore, initializeUsers, verifyPassword } = require('../store');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const env = {
    CHAT_USER1_NAME: '첫번째', CHAT_USER1_PASSWORD: 'first-test-password',
    CHAT_USER2_NAME: '두번째', CHAT_USER2_PASSWORD: 'second-test-password',
};

test('environment setup creates hashed accounts once and preserves them on redeploy', t => {
    const db = openStore(':memory:');
    t.after(() => db.close());
    initializeUsers(db, env);
    const users = db.prepare('SELECT * FROM users ORDER BY id').all();
    assert.equal(users.length, 2);
    assert.equal(verifyPassword(users[0], env.CHAT_USER1_PASSWORD), true);
    assert.notEqual(users[0].password_hash, env.CHAT_USER1_PASSWORD);
    initializeUsers(db, { ...env, CHAT_USER1_NAME: '바뀐이름', CHAT_USER1_PASSWORD: 'changed-test-password' });
    assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(), users);
    initializeUsers(db, {});
});

test('invalid environment setup never leaves a half-created pair of accounts', t => {
    const db = openStore(':memory:');
    t.after(() => db.close());
    assert.throws(() => initializeUsers(db, {}));
    assert.throws(() => initializeUsers(db, { ...env, CHAT_USER2_PASSWORD: 'short' }));
    assert.throws(() => initializeUsers(db, { ...env, CHAT_USER2_NAME: env.CHAT_USER1_NAME }));
    assert.throws(() => initializeUsers(db, { ...env, CHAT_USER2_PASSWORD: env.CHAT_USER1_PASSWORD }));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
});

test('old two-account schema migrates without losing messages or foreign keys', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'webchat-migration-'));
    const filename = path.join(directory, 'chat.sqlite');
    const old = new DatabaseSync(filename);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY CHECK (id IN (1, 2)), name TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
        INSERT INTO users VALUES (1, 'existing', 'salt', 'hash');
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), client_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id, client_id));
        INSERT INTO messages (user_id, client_id, body, created_at) VALUES (1, 'old-message', '보존할 대화', '2026-01-01T00:00:00Z');`);
    old.close();
    const db = openStore(filename);
    try {
        db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(-1, '게스트 1', '', '');
        assert.equal(db.prepare('SELECT body FROM messages').get().body, '보존할 대화');
        assert.equal(db.prepare('SELECT name FROM users WHERE id = 1').get().name, 'existing');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.throws(() => db.prepare('INSERT INTO messages (user_id, client_id, body, created_at) VALUES (99, ?, ?, ?)').run('invalid', 'no', 'now'));
    } finally {
        db.close();
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('webchat-migration-'));
        rmSync(directory, { recursive: true });
    }
});

test('registered account initialization remains available after guests have entered', t => {
    const db = openStore(':memory:');
    t.after(() => db.close());
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(-1, '게스트 1', '', '');
    initializeUsers(db, env);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 3);
    initializeUsers(db, {});
});
