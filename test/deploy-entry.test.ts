// Deployment entry points: API configuration from the environment, and the first-run bootstrap (workspace, owner,
// console key) — idempotent, so re-running it never duplicates a workspace or member.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootstrap } from '../src/admin/bootstrap.ts';
import { apiConfig } from '../src/api/main.ts';
import { resolveApiKey } from '../src/api/keys.ts';
import { freshDb } from './helpers.ts';

describe('deploy: API config', () => {
  it('needs DATABASE_URL; listens on loopback by default; reads port and CORS origins', () => {
    assert.throws(() => apiConfig({}), /DATABASE_URL/);
    const c = apiConfig({ DATABASE_URL: 'postgres://u:p@db:5432/postgate' });
    assert.deepEqual([c.host, c.port, c.corsOrigins], ['127.0.0.1', 8787, []]);
    const d = apiConfig({ DATABASE_URL: 'postgres://x', POSTGATE_API_HOST: '0.0.0.0', POSTGATE_API_PORT: '9000', POSTGATE_CORS_ORIGINS: 'http://a, http://b' });
    assert.deepEqual([d.host, d.port, d.corsOrigins], ['0.0.0.0', 9000, ['http://a', 'http://b']]);
    assert.throws(() => apiConfig({ DATABASE_URL: 'postgres://x', POSTGATE_API_PORT: 'abc' }), /POSTGATE_API_PORT/);
  });
});

describe('deploy: bootstrap', () => {
  it('creates the workspace, its owner and an owner key with every scope; re-running reuses both', async () => {
    const env = await freshDb();
    const a = await bootstrap(env.db, { slug: 'acme', name: 'Acme', owner: 'user:owner' });
    const b = await bootstrap(env.db, { slug: 'acme', name: 'Acme', owner: 'user:owner' });
    assert.equal(a.tenantId, b.tenantId);
    assert.notEqual(a.key, b.key, 'each run issues a fresh console key');
    const counts = (await env.db.query<{ t: number; m: number }>(
      `select (select count(*)::int from social.tenants) as t, (select count(*)::int from social.members) as m`)).rows[0]!;
    assert.deepEqual([counts.t, counts.m], [1, 1]);
    const p = await resolveApiKey(env.app, a.key);
    assert.equal(p?.role, 'owner');
    assert.equal(p?.memberRef, 'user:owner');
    assert.ok(p?.scopes.includes('channels:write') && p?.scopes.includes('approvals:decide'));
  });

  it('rejects an invalid slug before touching the database', async () => {
    const env = await freshDb();
    await assert.rejects(bootstrap(env.db, { slug: 'Bad Slug', name: 'x', owner: 'user:owner' }), /slug/);
  });

  it('registers a key generated elsewhere (e.g. by deployment tooling) exactly once', async () => {
    const env = await freshDb();
    const given = 'pgate_' + 'k'.repeat(43);
    const a = await bootstrap(env.db, { slug: 'local', name: 'Local', owner: 'user:owner', key: given });
    const b = await bootstrap(env.db, { slug: 'local', name: 'Local', owner: 'user:owner', key: given });
    assert.equal(a.key, given);
    assert.equal(b.key, given);
    const n = (await env.db.query<{ n: number }>(`select count(*)::int as n from social.api_keys`)).rows[0]!.n;
    assert.equal(n, 1, 'the same key is not registered twice');
    assert.equal((await resolveApiKey(env.app, given))?.role, 'owner');
    await assert.rejects(bootstrap(env.db, { slug: 'local', name: 'Local', owner: 'user:owner', key: 'short' }), /key/);
  });
});

