// Minimal database seam: the worker and repositories only need parameterised queries and transactions.
// Two adapters: node-postgres (production) and PGlite (tests: real Postgres in WASM, no server).
import type { Pool, PoolClient } from 'pg';
import type { PGlite, Transaction } from '@electric-sql/pglite';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** Runs fn in one transaction. When the adapter has a role, it is assumed with SET LOCAL ROLE first. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Multi-statement SQL without parameters (migrations). */
  exec(sql: string): Promise<void>;
}

/** Transaction scoped to one tenant: RLS policies read app.tenant_id via social.current_tenant(). */
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    return fn(tx);
  });
}

const ROLE = /^[a-z_][a-z0-9_]*$/;
const setRole = (role: string | undefined) => {
  if (role && !ROLE.test(role)) throw new Error(`invalid role name: ${role}`);
  return role ? `set local role ${role}` : null;
};

export function pgDb(pool: Pool, opts: { role?: string } = {}): Db {
  const roleSql = setRole(opts.role);
  return {
    query: async (sql, params) => ({ rows: (await pool.query(sql, params as unknown[])).rows }),
    exec: async (sql) => { await pool.query(sql); },
    async transaction(fn) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('begin');
        if (roleSql) await client.query(roleSql);
        const tx: Queryable = { query: async (sql, params) => ({ rows: (await client.query(sql, params as unknown[])).rows }) };
        const out = await fn(tx);
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

export function pgliteDb(pg: PGlite, opts: { role?: string } = {}): Db {
  const roleSql = setRole(opts.role);
  const wrap = (q: PGlite | Transaction): Queryable => ({
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await q.query<T>(sql, params)).rows }),
  });
  return {
    ...wrap(pg),
    exec: async (sql) => { await pg.exec(sql); },
    transaction: (fn) => pg.transaction(async (tx) => {
      if (roleSql) await tx.query(roleSql);
      return fn(wrap(tx));
    }),
  };
}

/** bytea comes back as Buffer (pg) or Uint8Array (PGlite). */
export const toBytes = (v: unknown): Uint8Array =>
  v instanceof Uint8Array ? v : new Uint8Array(Buffer.from(String(v ?? ''), 'hex'));
