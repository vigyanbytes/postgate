// Apply pending migrations and exit. Run: DATABASE_URL=… node src/db/migrate-main.ts [dir]
import pg from 'pg';
import { pgDb } from './db.ts';
import { migrate, MIGRATIONS_DIR } from './migrate.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const ran = await migrate(pgDb(pool), process.argv[2] ?? process.env.POSTGATE_MIGRATIONS_DIR ?? MIGRATIONS_DIR);
  console.log(ran.length ? `[postgate-migrate] applied ${ran.join(', ')}` : '[postgate-migrate] up to date');
} finally {
  await pool.end();
}
