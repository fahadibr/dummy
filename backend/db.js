const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'links.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    code TEXT PRIMARY KEY,
    target_url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

function createLink(code, targetUrl) {
  db.prepare('INSERT INTO links (code, target_url) VALUES (?, ?)').run(code, targetUrl);
}

function getLink(code) {
  return db.prepare('SELECT * FROM links WHERE code = ?').get(code);
}

function codeExists(code) {
  return !!getLink(code);
}

function listLinks() {
  return db.prepare('SELECT * FROM links ORDER BY created_at DESC LIMIT 50').all();
}

module.exports = { createLink, getLink, codeExists, listLinks };
