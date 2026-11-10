import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { withTenant } from '../src/db/db.ts';
import { credentialAad, keyRingFromSecrets, open, seal } from '../src/credentials/envelope.ts';
import { envSecretResolver } from '../src/credentials/secrets.ts';
import { loadToken, parseTokenValue, sealToken } from '../src/credentials/store.ts';
import { ProviderError } from '../src/providers/errors.ts';
import { freshDb, TENANT_A } from './helpers.ts';
import { seedPost, seedTenant } from './fixtures.ts';

// Test-only key material generated per run; nothing here is a real secret.
const env = { POSTGATE_KEK_V1: randomBytes(32).toString('base64'), POSTGATE_KEK_V2: randomBytes(32).toString('base64') };
const secrets = envSecretResolver(env);

describe('credentials: envelope encryption', () => {
  it('round-trips and binds the ciphertext to tenant + channel', () => {
    const ring = keyRingFromSecrets(secrets, 1);
    const s = seal('{"accessToken":"x"}', credentialAad('t1', 'c1'), ring);
    assert.equal(open(s, credentialAad('t1', 'c1'), ring), '{"accessToken":"x"}');
    assert.throws(() => open(s, credentialAad('t2', 'c1'), ring));
    assert.throws(() => open(s, credentialAad('t1', 'c2'), ring));
    assert.ok(!Buffer.from(s.ciphertext).toString('utf8').includes('accessToken'));
  });

  it('old key versions still open after rotation', () => {
    const s1 = seal('v1 secret', 'aad', keyRingFromSecrets(secrets, 1));
    const ring2 = keyRingFromSecrets(secrets, 2);
    assert.equal(seal('x', 'aad', ring2).keyVersion, 2);
    assert.equal(open(s1, 'aad', ring2), 'v1 secret');
  });

  it('refuses a missing or malformed KEK and invalid secret names', () => {
    assert.throws(() => keyRingFromSecrets(envSecretResolver({}), 1).current(), /not available/);
    assert.throws(() => keyRingFromSecrets(envSecretResolver({ POSTGATE_KEK_V1: 'c2hvcnQ=' }), 1).current(), /32 bytes/);
    assert.throws(() => secrets.get('lower_case'), /invalid secret name/);
  });

  it('parses bare and JSON token values', () => {
    assert.deepEqual(parseTokenValue('abc'), { accessToken: 'abc' });
    const t = parseTokenValue('{"access_token":"a","refresh_token":"r","expiresAt":"2026-12-01T00:00:00Z"}');
    assert.equal(t.refreshToken, 'r');
    assert.equal(t.expiresAt?.toISOString(), '2026-12-01T00:00:00.000Z');
  });
});

describe('credentials: store', () => {
  it('worker resolves a credential by variable name; a missing secret means reconnect', async () => {
    const { db, worker } = await freshDb();
    await seedTenant(db, TENANT_A, 'tenant-a');
    const s = await seedPost(db, TENANT_A, { envRef: 'LINKEDIN_MEMBER_TOKEN' });
    const deps = { secrets: envSecretResolver({ LINKEDIN_MEMBER_TOKEN: 'member-token' }) };
    const out = await withTenant(worker, TENANT_A, (tx) => loadToken(tx, { tenantId: TENANT_A, channelId: s.channelId, provider: 'linkedin' }, deps));
    assert.equal(out.token.accessToken, 'member-token');
    await assert.rejects(
      withTenant(worker, TENANT_A, (tx) => loadToken(tx, { tenantId: TENANT_A, channelId: s.channelId, provider: 'linkedin' }, { secrets: envSecretResolver({}) })),
      (e: unknown) => e instanceof ProviderError && e.kind === 'reconnect' && /LINKEDIN_MEMBER_TOKEN/.test(e.message));
  });

  it('console stores an envelope credential write-only; worker decrypts it', async () => {
    const { db, app, worker } = await freshDb();
    await seedTenant(db, TENANT_A, 'tenant-a');
    const ch = (await db.query<{ id: string }>(
      `insert into social.channels (tenant_id, provider, kind, external_id, display_name) values ($1, 'linkedin', 'personal', 'urn:li:person:z', 'Z') returning id`,
      [TENANT_A])).rows[0]!.id;
    const ring = keyRingFromSecrets(secrets, 1);
    const sealed = sealToken({ accessToken: 'tenant-token', refreshToken: 'rt' }, { tenantId: TENANT_A, channelId: ch }, ring);
    await withTenant(app, TENANT_A, (tx) => tx.query('select social.store_channel_credential($1, $2, null, $3, $4, $5)',
      [ch, 'envelope', sealed.ciphertext, sealed.dekWrapped, sealed.keyVersion]));
    await assert.rejects(withTenant(app, TENANT_A, (tx) => tx.query('select * from social.channel_credentials')), /permission denied/);
    const out = await withTenant(worker, TENANT_A, (tx) => loadToken(tx, { tenantId: TENANT_A, channelId: ch, provider: 'linkedin' }, { secrets, keyRing: ring }));
    assert.deepEqual([out.token.accessToken, out.token.refreshToken, out.source], ['tenant-token', 'rt', 'envelope']);
    const audit = (await db.query<{ action: string; detail: Record<string, unknown> }>('select action, detail from social.audit_log')).rows;
    assert.equal(audit[0]?.action, 'credential.stored');
    assert.ok(!JSON.stringify(audit).includes('tenant-token'));
  });
});
