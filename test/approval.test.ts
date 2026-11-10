import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withTenant } from '../src/db/db.ts';
import { ApprovalError, canonicalJson, checkGate, contentHash, decideApproval, expireApprovals, rehashPost, requestApproval, schedulePost } from '../src/approval/gate.ts';
import { freshDb, TENANT_A } from './helpers.ts';
import { one, seedPost, seedTenant } from './fixtures.ts';

const base = { title: null, body: 'b', mediaIds: ['m2', 'm1'], linkUrl: null, targets: [
  { channelId: 'c2', bodyOverride: null, settings: { b: 1, a: 2 } }, { channelId: 'c1', bodyOverride: 'x', settings: {} }] };

describe('approval: content hash', () => {
  it('is stable under key/array order and changes with any content', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
    const h = contentHash(base);
    assert.equal(h, contentHash({ ...base, mediaIds: ['m1', 'm2'], targets: [...base.targets].reverse() }));
    assert.notEqual(h, contentHash({ ...base, body: 'b!' }));
    assert.notEqual(h, contentHash({ ...base, targets: [{ ...base.targets[0]!, settings: { firstComment: 'hi' } }, base.targets[1]!] }));
  });
});

async function setup() {
  const env = await freshDb();
  await seedTenant(env.db, TENANT_A, 'tenant-a');
  const s = await seedPost(env.db, TENANT_A);
  return { ...env, s, asApp: <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(env.app, TENANT_A, fn) };
}

const status = (db: Parameters<typeof one>[0], table: string, id: string) =>
  one<{ status: string }>(db, `select status from social.${table} where id = $1`, [id]).then((r) => r.status);

describe('approval: request and decide (as the console role, under RLS)', () => {
  it('approve via one-time link token; token works once; post becomes scheduled when it has a time', async () => {
    const { db, s, asApp } = await setup();
    await asApp((tx) => tx.query(`update social.posts set scheduled_at = now() + interval '1 day' where id = $1`, [s.postId]));
    const { approvalId, token } = await asApp((tx) => requestApproval(tx, { tenantId: TENANT_A, postId: s.postId, requestedBy: 'u-author', via: ['chat'] }));
    assert.equal(await status(db, 'posts', s.postId), 'in_review');
    const stored = await one<{ token_hash: string }>(db, 'select token_hash from social.approvals where id = $1', [approvalId]);
    assert.notEqual(stored.token_hash, token);
    const out = await asApp((tx) => decideApproval(tx, { tenantId: TENANT_A, token, decision: 'approved', actor: 'u-boss', via: 'chat' }));
    assert.equal(out.postStatus, 'scheduled');
    await assert.rejects(asApp((tx) => decideApproval(tx, { tenantId: TENANT_A, token, decision: 'approved', actor: 'u-boss', via: 'chat' })),
      (e: unknown) => e instanceof ApprovalError && e.code === 'not_found');
    assert.deepEqual(await asApp((tx) => checkGate(tx, s.postId)), { ok: true, approvalId });
    const actions = (await db.query<{ action: string }>('select action from social.audit_log order by id')).rows.map((r) => r.action);
    assert.deepEqual(actions, ['approval.requested', 'approval.approved']);
  });

  it('rejects non-approvers, expired requests and author self-approval when the tenant requires it', async () => {
    const { db, s, asApp } = await setup();
    const r1 = await asApp((tx) => requestApproval(tx, { tenantId: TENANT_A, postId: s.postId, requestedBy: 'u-author' }));
    await assert.rejects(asApp((tx) => decideApproval(tx, { tenantId: TENANT_A, approvalId: r1.approvalId, decision: 'approved', actor: 'u-author', via: 'console' })),
      (e: unknown) => e instanceof ApprovalError && e.code === 'forbidden');
    await assert.rejects(asApp((tx) => decideApproval(tx, { tenantId: TENANT_A, approvalId: r1.approvalId, decision: 'approved', actor: 'u-boss', via: 'console',
      now: new Date(Date.now() + 49 * 3_600_000) })), (e: unknown) => e instanceof ApprovalError && e.code === 'expired');
    assert.equal(await asApp((tx) => expireApprovals(tx, new Date(Date.now() + 49 * 3_600_000))), 1);
    assert.equal(await status(db, 'approvals', r1.approvalId), 'expired');

    await db.query(`update social.tenants set settings = '{"approver_must_differ": true}' where id = $1`, [TENANT_A]);
    await db.query(`update social.members set role = 'approver' where user_ref = 'u-author'`);
    const r2 = await asApp((tx) => requestApproval(tx, { tenantId: TENANT_A, postId: s.postId, requestedBy: 'u-author' }));
    await assert.rejects(asApp((tx) => decideApproval(tx, { tenantId: TENANT_A, approvalId: r2.approvalId, decision: 'approved', actor: 'u-author', via: 'console' })),
      /approver to differ/);
  });

  it('a content edit after approval supersedes it and returns the post to review', async () => {
    const { db, s, asApp } = await setup();
    const r = await asApp((tx) => requestApproval(tx, { tenantId: TENANT_A, postId: s.postId, requestedBy: 'u-author' }));
    await asApp((tx) => decideApproval(tx, { tenantId: TENANT_A, approvalId: r.approvalId, decision: 'approved', actor: 'u-boss', via: 'console' }));
    await asApp((tx) => schedulePost(tx, s.postId, new Date(Date.now() + 3_600_000)));
    assert.equal(await status(db, 'posts', s.postId), 'scheduled');

    // Editing content without re-hashing is refused by the database.
    await assert.rejects(asApp((tx) => tx.query(`update social.posts set body = 'changed' where id = $1`, [s.postId])), /without a new content_hash/);
    // Editing and re-hashing supersedes the approval and drops the schedule back to review.
    await asApp(async (tx) => {
      await tx.query(`update social.posts set body = 'changed', content_hash = null where id = $1`, [s.postId]);
      await rehashPost(tx, s.postId);
    });
    assert.equal(await status(db, 'approvals', r.approvalId), 'superseded');
    assert.equal(await status(db, 'posts', s.postId), 'in_review');
    assert.deepEqual(await asApp((tx) => checkGate(tx, s.postId)), { ok: false, reason: 'no approval' });
  });

  it('changing a target override clears the hash and supersedes the approval', async () => {
    const { db, s, asApp } = await setup();
    const r = await asApp((tx) => requestApproval(tx, { tenantId: TENANT_A, postId: s.postId, requestedBy: 'u-author' }));
    await asApp((tx) => decideApproval(tx, { tenantId: TENANT_A, approvalId: r.approvalId, decision: 'approved', actor: 'u-boss', via: 'console' }));
    await asApp((tx) => tx.query(`update social.post_targets set body_override = 'sneaky' where id = $1`, [s.targetId]));
    assert.equal(await status(db, 'approvals', r.approvalId), 'superseded');
    assert.equal((await one<{ content_hash: string | null }>(db, 'select content_hash from social.posts where id = $1', [s.postId])).content_hash, null);
  });

  it('the database refuses to schedule or queue unapproved content, whoever asks', async () => {
    const { db, s, asApp } = await setup();
    await asApp((tx) => rehashPost(tx, s.postId));
    await assert.rejects(asApp((tx) => schedulePost(tx, s.postId, new Date())), /no approval/);
    await assert.rejects(db.query(`update social.post_targets set status = 'queued' where id = $1`, [s.targetId]), /not approved/);
  });
});

describe('tenancy: RLS', () => {
  it('a tenant sees only its own rows; no tenant set sees nothing; cross-tenant writes fail', async () => {
    const { db, app } = await freshDb();
    const B = '00000000-0000-4000-8000-00000000000b';
    await seedTenant(db, TENANT_A, 'tenant-a');
    await seedTenant(db, B, 'tenant-b');
    const a = await seedPost(db, TENANT_A);
    await seedPost(db, B);
    const posts = await withTenant(app, TENANT_A, (tx) => tx.query<{ id: string }>('select id from social.posts'));
    assert.deepEqual(posts.rows.map((r) => r.id), [a.postId]);
    assert.equal((await app.transaction((tx) => tx.query('select id from social.posts'))).rows.length, 0);
    await assert.rejects(withTenant(app, TENANT_A, (tx) => tx.query(
      `insert into social.posts (tenant_id, body, created_by) values ($1, 'x', 'u')`, [B])), /row-level security/);
    await assert.rejects(withTenant(app, TENANT_A, (tx) => tx.query(`select social.enqueue_job($1, 'x', 'k')`, [B])), /not the current tenant/);
    await assert.rejects(withTenant(app, TENANT_A, (tx) => tx.query('select * from social.jobs')), /permission denied/);
    await db.query(`insert into social.audit_log (tenant_id, actor, action, subject_type, subject_id) values ($1, 'u', 'x', 'post', '1')`, [TENANT_A]);
    await assert.rejects(db.query(`delete from social.audit_log`), /append-only/);
    await assert.rejects(db.query(`update social.audit_log set action = 'y'`), /append-only/);
  });
});
