const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// Prefer KAVRYON_DB. VYNTRIX_DB is a one-time migration fallback for existing deployments.
const dbPath = process.env.KAVRYON_DB || process.env.VYNTRIX_DB || '/tmp/kavryon.sqlite';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const raw = new DatabaseSync(dbPath);
raw.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
raw.exec(schema);

function prepare(sql) {
  const stmt = raw.prepare(sql);
  return {
    run(...args) { return stmt.run(...args); },
    get(...args) { return stmt.get(...args); },
    all(...args) { return stmt.all(...args); }
  };
}

function exec(sql) { raw.exec(sql); }

function transaction(fn) {
  return function wrapped(...args) {
    const name = 'sp_' + Math.random().toString(16).slice(2);
    raw.exec('SAVEPOINT ' + name);
    try {
      const out = fn(...args);
      raw.exec('RELEASE ' + name);
      return out;
    } catch (e) {
      raw.exec('ROLLBACK TO ' + name);
      raw.exec('RELEASE ' + name);
      throw e;
    }
  };
}

module.exports = { prepare, exec, transaction };
