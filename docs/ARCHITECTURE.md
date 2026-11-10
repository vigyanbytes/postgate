# Architecture

## Processes

| Process | Entry | Database role | Does |
|---|---|---|---|
| migrate | `src/db/migrate-main.ts` | owner | applies `db/migrations/*.sql` once each (checksummed) |
| init | `src/admin/bootstrap.ts` | owner | first tenant, its owner member and an owner key (idempotent) |
| api | `src/api/main.ts` | `social_app` | the HTTP API; never calls a platform |
| worker | `src/worker/main.ts` | `social_worker` | scheduler tick + job loop; the only process that reads tokens and calls platforms |

Run as many workers as you like: claims use `FOR UPDATE SKIP LOCKED` and leases.

## Tenancy

Every table has `tenant_id`; row-level security is **forced** (owners too). A transaction sets
`app.tenant_id`, policies compare against it. The API learns the tenant from the key (`resolve_api_key`, security
definer). The worker claims jobs across tenants through security-definer queue functions, then opens a transaction
scoped to that job's tenant, so a bug in one job cannot read another tenant's rows. `social_app` cannot read
`channel_credentials` or `jobs` at all; it writes credentials through `store_channel_credential()` and jobs through
`enqueue_job()`, both of which refuse a tenant other than the current one.

Single-tenant use is simply one tenant (`default`), created on first run.

## Post lifecycle

```
draft ──request approval──▶ in_review ──approve──▶ approved ──schedule──▶ scheduled ──due──▶ publishing ──▶ published
  ▲                              │reject                                                        │        partially_failed
  └───────── any content edit ◀──┴──────────────────────────────────────────────────────────────┘        failed / cancelled
```
Per channel (`post_targets`): `pending → queued → publishing → published | needs_attention | failed | cancelled`.

## The approval gate (db/migrations/0003_approval_gate.sql)

- The approved object is a SHA-256 over canonical JSON of title, body, media ids, link and every target's channel,
  variant text and settings (`src/approval/gate.ts`).
- A post becomes `approved`/`scheduled`, and a target `queued`/`publishing`, only when an approval with the post's
  **current** hash exists. Content edits clear the hash; a new hash supersedes old approvals.
- The worker checks the gate again right before calling the platform.
- Approvals are decided by a human member with an approver role; automation keys cannot hold the scope.
  A tenant setting `approver_must_differ` forbids self-approval.

## Queue (db/migrations/0004_queue.sql)

`enqueue_job` (idempotent on kind + key), `claim_jobs` (due jobs and expired leases; increments attempts; marks a job
`dead` when its lease expires on the final attempt), `complete_job` / `fail_job` (only the lease holder; a late worker
learns it lost the lease), `enqueue_due_publishes` (approved, due targets → jobs; overdue beyond 6 h or no longer
approved → `needs_attention`, never a surprise late post).

## Publishing exactly once

Before calling the platform the worker commits `publishing`. If a previous attempt was already `publishing` (crash,
timeout), the next attempt asks the platform whether the post exists (`reconcile`) and records it, or parks the target
for a human when the platform cannot be asked. Errors are classified per platform into `retryable`, `reconnect`,
`fatal` and `unknown_outcome` (see `docs/PROVIDERS.md`).

## Media

Uploaded through the API into `POSTGATE_MEDIA_DIR` (content-addressed per tenant). Platforms that receive bytes get
bytes; platforms that download from a URL (Instagram, Facebook) get a short-lived HMAC-signed URL to the API's
`/media/` route, which must then be reachable from the internet over https (`POSTGATE_PUBLIC_URL`).

## Credentials

`channel_credentials` holds either `env_ref` — the name of an environment variable in the worker — or an
envelope-encrypted token (AES-256-GCM data key wrapped by a key-encryption key `POSTGATE_KEK_V<n>` from the
environment, bound to tenant + channel). The quick start uses `env_ref` only. A value may be a bare token or a JSON
token set (with refresh token and expiry); the worker refreshes before expiry when the platform allows it.

## Stand-ins

`src/standin/` imitates the endpoints we call on each platform. `POSTGATE_STANDIN_URL` (loopback only) points a worker at
it for rehearsals; `postgate doctor` runs publish code against it in-process to print the exact requests; the
end-to-end test runs everything against it. Stand-ins prove our side, not the platform's acceptance.
