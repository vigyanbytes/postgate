// Worker entry point: environment -> validated config -> WorkerDeps (no live services), and graceful stop.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { buildDeps, stopOnSignals, workerConfig } from '../src/worker/main.ts';

function fakePool() {
  const queries: string[] = [];
  const client = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; }, release: () => {} };
  return { queries, pool: { query: async (sql: string) => { queries.push(sql); return { rows: [] }; }, connect: async () => client } };
}

describe('worker main: config', () => {
  it('needs DATABASE_URL; defaults are sane; stand-in mode is off unless asked', () => {
    assert.throws(() => workerConfig({}), /DATABASE_URL/);
    const c = workerConfig({ DATABASE_URL: 'postgres://w@db/postgate' });
    assert.equal(c.databaseUrl, 'postgres://w@db/postgate');
    assert.ok(c.workerId.length > 0);
    assert.equal(c.pollMs, 15_000);
    assert.equal(c.standinUrl, undefined);
    assert.throws(() => workerConfig({ DATABASE_URL: 'x', POSTGATE_POLL_MS: '-1' }), /POSTGATE_POLL_MS/);
  });
});

describe('worker main: deps', () => {
  it('acts as role social_worker; media storage only when configured', async () => {
    const { pool, queries } = fakePool();
    const bare = buildDeps(workerConfig({ DATABASE_URL: 'x' }), { pool: pool as any, env: {} });
    await bare.db.transaction(async (tx) => tx.query('select 1'));
    assert.ok(queries.includes('set local role social_worker'));
    await assert.rejects(bare.storage.read('k'), /media storage is not configured/);
    assert.equal(bare.storage.publicUrl, undefined);
    const withUrls = buildDeps(workerConfig({ DATABASE_URL: 'x', POSTGATE_MEDIA_DIR: '/tmp/none', POSTGATE_PUBLIC_URL: 'https://media.example.com',
      POSTGATE_MEDIA_URL_SECRET: 's'.repeat(32) }), { pool: pool as any, env: {} });
    assert.equal(typeof withUrls.storage.publicUrl, 'function');
  });

  it('channel tokens resolve from the environment by variable name', () => {
    const { pool } = fakePool();
    const d = buildDeps(workerConfig({ DATABASE_URL: 'x' }), { pool: pool as any, env: { LINKEDIN_TOKEN: 't' } });
    assert.equal(d.credentials.secrets.get('LINKEDIN_TOKEN'), 't');
  });

  it('stand-in mode rewrites platform calls to the loopback stand-in and refuses a non-loopback target', async () => {
    const { pool } = fakePool();
    const seen: string[] = [];
    const fetchImpl = (async (u: string) => { seen.push(u); return new Response('{}'); }) as typeof fetch;
    const d = buildDeps(workerConfig({ DATABASE_URL: 'x', POSTGATE_STANDIN_URL: 'http://127.0.0.1:9' }), { pool: pool as any, env: {}, fetch: fetchImpl });
    await d.http.request({ url: 'https://api.x.com/2/tweets?a=1' });
    assert.deepEqual(seen, ['http://127.0.0.1:9/api.x.com/2/tweets?a=1']);
    assert.throws(() => buildDeps(workerConfig({ DATABASE_URL: 'x', POSTGATE_STANDIN_URL: 'https://203.0.113.5' }), { pool: pool as any, env: {} }), /loopback/);
  });
});

describe('worker main: graceful stop', () => {
  it('SIGTERM or SIGINT aborts the run loop once', () => {
    const proc = new EventEmitter();
    const ctl = stopOnSignals(proc as any);
    assert.equal(ctl.signal.aborted, false);
    proc.emit('SIGTERM');
    assert.equal(ctl.signal.aborted, true);
    proc.emit('SIGINT');
    assert.equal(ctl.signal.aborted, true);
  });
});
