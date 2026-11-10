// Applies db/migrations/*.sql in name order, once each, recording a checksum.
// A changed checksum on an applied file is an error: write a new migration instead of editing an old one.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.ts';

export const MIGRATIONS_DIR = new URL('../../db/migrations/', import.meta.url).pathname;

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`create table if not exists public.postgate_schema_migrations (
    name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
  const applied = new Map(
    (await db.query<{ name: string; sha256: string }>('select name, sha256 from public.postgate_schema_migrations'))
      .rows.map((r) => [r.name, r.sha256]),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const name of files) {
    const sql = await readFile(join(dir, name), 'utf8');
    const sha = createHash('sha256').update(sql).digest('hex');
    const prev = applied.get(name);
    if (prev) {
      if (prev !== sha) throw new Error(`migration ${name} changed after it was applied`);
      continue;
    }
    try {
      await db.exec(`begin;\n${sql}\n;insert into public.postgate_schema_migrations (name, sha256) values ('${name.replace(/'/g, "''")}', '${sha}');\ncommit;`);
    } catch (e) {
      await db.exec('rollback').catch(() => {});
      throw new Error(`migration ${name} failed: ${(e as Error).message}`);
    }
    ran.push(name);
  }
  return ran;
}
