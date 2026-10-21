import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Key-value storage that outlives the process, for answers that never change, such as geocodes. */
export interface DurableStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  close(): void;
}

export function sqliteStore(file: string): DurableStore {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, created INTEGER NOT NULL)'
  );
  const read = db.prepare('SELECT value FROM kv WHERE key = ?');
  const write = db.prepare(
    'INSERT OR REPLACE INTO kv (key, value, created) VALUES (?, ?, ?)'
  );
  return {
    get<T>(key: string) {
      const row = read.get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    set(key, value) {
      write.run(key, JSON.stringify(value), Date.now());
    },
    close() {
      db.close();
    }
  };
}

export function memoryDurableStore(): DurableStore {
  const entries = new Map<string, string>();
  return {
    get<T>(key: string) {
      const raw = entries.get(key);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    set(key, value) {
      entries.set(key, JSON.stringify(value));
    },
    close() {
      entries.clear();
    }
  };
}
