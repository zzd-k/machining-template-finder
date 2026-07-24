import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve relative to project root (server/src/db -> ../../..)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DB_PATH = path.resolve(PROJECT_ROOT, process.env.MTF_DB_PATH || './data/templates.db');
console.log('[DB] Using database path:', DB_PATH);

// Ensure data directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS drawings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_path TEXT NOT NULL,
    thumbnail_path TEXT,
    description TEXT DEFAULT '',
    material TEXT DEFAULT '',
    machining_params TEXT DEFAULT '{}',
    embedding BLOB,
    embedding_dim INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_drawings_created ON drawings(created_at);
`);

export default db;