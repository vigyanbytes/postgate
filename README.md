# postgate

A small, self-hosted social media scheduler where **nothing is published without a human approval**.
Compose a post (text + media) with per-channel variants, ask for approval, schedule it, and a worker publishes it to
**LinkedIn (profile and Page), Facebook Pages, Instagram, YouTube and X**.

- **Approval gate in the database**: a human approves the exact content (a hash over text, media and every channel's
  variant and settings). Any edit voids the approval. Triggers refuse to queue or publish anything else, whatever the
  code path. Moving the time keeps the approval; changing the words does not.
- **Postgres is the queue**: `FOR UPDATE SKIP LOCKED`, leases, retries with backoff and jitter, dead jobs kept for
  inspection, idempotency keys, and a reconcile step so a timed-out create is looked up instead of posted twice.
- **Multi-tenant** (tenant id + row-level security on every table, separate runtime roles for API and worker), with a
  single-tenant quick start.
- **HTTP API, CLI and an MCP server** for agents. Agents get automation keys: they can draft, upload media, ask for
  approval and propose times — never approve or publish.
- **Tokens by name**: a channel stores the *name* of the environment variable that holds its token, never the token.
- `postgate doctor` shows the exact requests a publish would send, without sending them.

Apache-2.0. Node.js 24+, Postgres (tested with 17). One runtime dependency (`pg`).

> **Status: early.** Every provider is written from the platforms' public docs and tested against local stand-ins of
> their APIs; **none has sent a real post yet**. See [docs/PROVIDERS.md](docs/PROVIDERS.md) and run
> [docs/REAL-TEST.md](docs/REAL-TEST.md) before relying on a network.

## Quick start (Docker)

```bash
git clone <this repository> postgate && cd postgate
cp .env.example .env                 # set POSTGRES_PASSWORD; channel tokens go here later
docker compose up -d                 # Postgres, migrations, first-run setup, API on 127.0.0.1:8787, worker
docker compose logs init             # your owner key, shown once — put it in your secret manager
```

Then, with Node 24 on the host (`npm ci` once) or inside the container (`docker compose exec api node bin/postgate.ts …`):

```bash
export POSTGATE_URL=http://127.0.0.1:8787 POSTGATE_KEY=<owner key>
alias postgate="node bin/postgate.ts"

postgate oauth linkedin --out ~/.postgate-tokens          # or bring your own token
#   add LINKEDIN_MEMBER_TOKEN=<file content> to .env, then: docker compose up -d worker
postgate doctor --provider linkedin --external-id urn:li:person:<id> --token-env LINKEDIN_MEMBER_TOKEN --text "hello"
postgate channel add --provider linkedin --external-id urn:li:person:<id> --token-env LINKEDIN_MEMBER_TOKEN

postgate media upload ./photo.jpg --alt "what the image shows"
postgate draft --body "Hello from postgate" --target linkedin --target x --variant x="Hello, X" --media <media id>
postgate request-approval <post id>
postgate approve <post id>                                 # a human member key
postgate schedule <post id> --at 2026-12-01T09:30 --tz Europe/Berlin
postgate post <post id>                                    # status and links per channel
```

## Agents (MCP)

```bash
postgate key create my-agent          # automation key: draft, media, approval requests, schedule — never approve
```
Register the stdio server with your agent, e.g. Claude Code:
```bash
claude mcp add postgate -e POSTGATE_URL=http://127.0.0.1:8787 -e POSTGATE_KEY=<automation key> -- node /path/to/postgate/bin/postgate-mcp.ts
```
Tools: `channels_list`, `posts_list`, `post_get`, `media_upload`, `draft_create`, `post_validate`, `approval_request`,
`schedule_set`, `schedule_clear`. The server refuses to start with a key that can approve.

## How it fits together

```
 CLI / scripts / MCP (agents)          human approver (member key)
            │  automation key                 │ approve
            ▼                                 ▼
 ┌──────────────────── HTTP API (role social_app, RLS per tenant) ───────────────────┐
 │ drafts · media · approval requests · decisions · schedule · channels · keys        │
 └──────────────────────────────────────┬────────────────────────────────────────────┘
                                        ▼
 ┌──────────────────────────── Postgres, schema social ──────────────────────────────┐
 │ posts · post_targets · approvals (content hash) · jobs (queue) · events · audit_log │
 │ gate triggers: no approved hash → no queued/publishing target                      │
 └──────────────────────────────────────▲────────────────────────────────────────────┘
                                        │ claim (SKIP LOCKED, lease) → per-tenant transaction
 ┌──────────────────────────── worker (role social_worker) ───────────────────────────┐
 │ due tick → publish_target → provider plugin → platform API → published / retry /   │
 │ needs_attention / failed;  first_comment;  delete_target (unpublish)               │
 └───────────────────────────────────────────────────────────────────────────────────┘
```
More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/API.md](docs/API.md), [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Without Docker

```bash
npm ci
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgate   # a superuser or a role with BYPASSRLS runs migrations
npm run migrate && npm run bootstrap                               # prints the owner key once
POSTGATE_MEDIA_DIR=./.data/media npm run api &
POSTGATE_MEDIA_DIR=./.data/media npm run worker
```

## Development

```bash
npm ci && npm test          # ~120 tests: PGlite runs the real migrations in-process; no network, no Docker
npm run typecheck
```
`test/e2e.test.ts` runs API, CLI, MCP and worker against stand-ins of all six platforms with a guard that fails on
any non-loopback request. `test/leak-scan.test.mjs` keeps machine- and deployment-specific details out of the
repository (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Platform names are trademarks of their owners; this project
is not affiliated with or endorsed by them.
