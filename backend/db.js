// Two backends behind the same async interface:
// - DATABASE_URL set (Render's managed Postgres) -> use it. Links then
//   survive the web service sleeping/restarting (Render's free-tier disk is
//   ephemeral, so SQLite alone would lose every link on each restart).
// - otherwise -> local SQLite file, for local development.
const USE_POSTGRES = !!process.env.DATABASE_URL;

let impl;

if (USE_POSTGRES) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      code TEXT PRIMARY KEY,
      target_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  impl = {
    async createLink(code, targetUrl) {
      await ready;
      await pool.query('INSERT INTO links (code, target_url) VALUES ($1, $2)', [code, targetUrl]);
    },
    async getLink(code) {
      await ready;
      const { rows } = await pool.query('SELECT * FROM links WHERE code = $1', [code]);
      return rows[0];
    },
    async codeExists(code) {
      return !!(await impl.getLink(code));
    },
    async listLinks() {
      await ready;
      const { rows } = await pool.query('SELECT * FROM links ORDER BY created_at DESC LIMIT 50');
      return rows;
    },
  };
} else {
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

  impl = {
    async createLink(code, targetUrl) {
      db.prepare('INSERT INTO links (code, target_url) VALUES (?, ?)').run(code, targetUrl);
    },
    async getLink(code) {
      return db.prepare('SELECT * FROM links WHERE code = ?').get(code);
    },
    async codeExists(code) {
      return !!(await impl.getLink(code));
    },
    async listLinks() {
      return db.prepare('SELECT * FROM links ORDER BY created_at DESC LIMIT 50').all();
    },
  };
}

module.exports = impl;
