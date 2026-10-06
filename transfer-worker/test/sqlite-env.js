import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

// Execute actual migrations and SQL, rather than simulating query text with maps.
export function fakeEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return statement.get(...args) || null; },
        async run() { const result = statement.run(...args); return { meta: { changes: Number(result.changes) } }; },
        async all() { return { results: statement.all(...args) }; }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  let object = null;
  return { DB, sqlite,
    OBJECTS: { head: async () => object, delete: async () => { object = null; } },
    setPlan(id, plan) { sqlite.prepare('UPDATE devices SET plan = ? WHERE id = ?').run(plan, id); },
    setLastSeen(id, time) { sqlite.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(time, id); },
    setObject(value) { object = value; }, getObject() { return object; },
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_BUCKET_NAME: 'cachetray-transfers',
    R2_ACCESS_KEY_ID: 'test-access-key', R2_SECRET_ACCESS_KEY: 'test-secret-key',
    WEB_ORIGIN: 'https://cachetray.example', EXTENSION_ORIGIN: 'chrome-extension://abcdef' };
}
