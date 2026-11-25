import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createClient, type Transaction } from '@libsql/client/web';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (Boolean(url) !== Boolean(authToken)) throw new Error('Set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.');
if (process.env.VERCEL && !url) throw new Error('Vercel requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN; local SQLite is not persistent.');
const remote = url ? createClient({ url, authToken }) : null;
const path = process.env.SIMP_DB || './var/simp.sqlite';
if (!remote && path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
const local = remote ? null : new DatabaseSync(path);
local?.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
const context = new AsyncLocalStorage<Transaction | DatabaseSync>();

// Keep async requests outside another request's local transaction.
let pending = Promise.resolve();
async function localLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = pending;
  let release!: () => void;
  pending = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await work(); } finally { release(); }
}

export async function tx<T>(work: () => Promise<T>): Promise<T> {
  if (context.getStore()) return work();
  if (remote) {
    const transaction = await remote.transaction('write');
    try {
      const result = await context.run(transaction, work);
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally { transaction.close(); }
  }
  return localLock(async () => {
    local!.exec('BEGIN IMMEDIATE');
    try {
      const result = await context.run(local!, work);
      local!.exec('COMMIT');
      return result;
    } catch (error) {
      local!.exec('ROLLBACK');
      throw error;
    }
  });
}

async function query(sql: string, params: any[], kind: 'one' | 'all' | 'run'): Promise<any> {
  const connection = context.getStore();
  if (remote) {
    const result = await ((connection as Transaction) ?? remote).execute({ sql, args: params });
    const rows = result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, value instanceof ArrayBuffer ? Buffer.from(value) : value])));
    return kind === 'one' ? rows[0] : kind === 'all' ? rows : { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
  }
  const work = async () => {
    const statement = local!.prepare(sql);
    return kind === 'one' ? statement.get(...params) : kind === 'all' ? statement.all(...params) : statement.run(...params);
  };
  return connection ? work() : localLock(work);
}

export const one = (sql: string, ...params: any[]): Promise<any> => query(sql, params, 'one');
export const all = (sql: string, ...params: any[]): Promise<any[]> => query(sql, params, 'all');
export const run = (sql: string, ...params: any[]): Promise<any> => query(sql, params, 'run');

export async function exec(sql: string) {
  const connection = context.getStore();
  if (remote) return ((connection as Transaction) ?? remote).executeMultiple(sql);
  if (connection) return local!.exec(sql);
  return localLock(async () => local!.exec(sql));
}

export function closeDatabase() {
  remote?.close();
  local?.close();
}
