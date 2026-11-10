import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withTenant } from '../src/db/db.ts';
import { backoffMs, claim, complete, enqueue, fail } from '../src/queue/queue.ts';
import { freshDb, TENANT_A } from './helpers.ts';
import { one, seedTenant } from './fixtures.ts';

describe('queue: backoff', () => {
  it('grows exponentially, is capped, and honours Retry-After', () => {
    const max = { random: () => 1 };
    assert.equal(backoffMs(1, max), 30_000);
    assert.equal(backoffMs(3, max), 120_000);
    assert.equal(backoffMs(30, max), 6 * 3_600_000);
    assert.equal(backoffMs(1, { random: () => 0 }), 15_000); // floor: half the base
    assert.equal(backoffMs(1, { random: () => 1, retryAfterMs: 3_600_000 }), 3_600_000);
  });
});

describe('queue: SQL functions', () => {
  async function setup() {
    const env = await freshDb();
    await seedTenant(env.db, TENANT_A, 'tenant-a');
    const add = (key: string, maxAttempts = 3) =>
      withTenant(env.app, TENANT_A, (tx) => enqueue(tx, { tenantId: TENANT_A, kind: 'test', key, maxAttempts }));
    const pastDue = (id: string) => env.db.query(`update social.jobs set run_at = now() - interval '1 second' where id = $1`, [id]);
    const job = (id: string) => one<{ status: string; attempts: number; locked_by: string | null }>(env.db,
      'select status, attempts, locked_by from social.jobs where id = $1', [id]);
    return { ...env, add, pastDue, job };
  }

  it('enqueue is idempotent on (kind, key)', async () => {
    const { add, db } = await setup();
    assert.equal(await add('k1'), await add('k1'));
    assert.equal((await one<{ n: number }>(db, 'select count(*)::int as n from social.jobs')).n, 1);
  });

  it('a claimed job is invisible to other workers until its lease expires; then the old holder loses it', async () => {
    const { add, worker, db, job } = await setup();
    const id = await add('k1');
    assert.equal((await claim(worker, 'w1')).length, 1);
    assert.equal((await claim(worker, 'w2')).length, 0);
    await db.query(`update social.jobs set locked_until = now() - interval '1 second' where id = $1`, [id]);
    const re = await claim(worker, 'w2');
    assert.equal(re[0]?.attempts, 2);
    assert.equal(await complete(worker, id, 'w1'), false);
    assert.equal(await complete(worker, id, 'w2'), true);
    assert.equal((await job(id)).status, 'succeeded');
  });

  it('retry waits for run_at; attempts exhausted -> dead; expired lease on last attempt -> dead', async () => {
    const { add, worker, db, pastDue, job } = await setup();
    const id = await add('k1', 2);
    await claim(worker, 'w1');
    assert.equal(await fail(worker, id, 'w1', { e: 1 }, new Date(Date.now() + 60_000)), 'queued');
    assert.equal((await claim(worker, 'w1')).length, 0);
    await pastDue(id);
    await claim(worker, 'w1');
    assert.equal(await fail(worker, id, 'w1', { e: 2 }, new Date()), 'dead');

    const id2 = await add('k2', 1);
    await claim(worker, 'w1');
    await db.query(`update social.jobs set locked_until = now() - interval '1 second' where id = $1`, [id2]);
    await claim(worker, 'w2');
    assert.equal((await job(id2)).status, 'dead');
  });

  it('only the worker role can claim', async () => {
    const { add, app } = await setup();
    await add('k1');
    await assert.rejects(claim(app, 'w1'), /permission denied/);
  });
});
