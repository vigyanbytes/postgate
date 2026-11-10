# Contributing

Thanks for helping. Small, focused pull requests with tests are easiest to review.

## Setup

```bash
npm ci
npm test            # node:test; PGlite runs the real migrations in-process (no Postgres, no Docker, no network)
npm run typecheck   # tsc, no emit; Node 24 runs the .ts files directly (erasable syntax only: no enums/namespaces)
```

## Ground rules

- **Never weaken the approval gate.** Any change that lets content reach a platform without an approval for its exact
  current hash will be declined. Gate rules live in SQL (`db/migrations/0003_approval_gate.sql`) and are tested there.
- **Never handle token values** in the API, logs, events, audit rows or test fixtures. Reference secrets by
  environment-variable name.
- **Migrations are append-only.** Do not edit an applied migration; add a new numbered file.
- **Providers are written from the platform's public documentation.** Put the doc links in the file header. Do not
  copy code from other schedulers (in particular, nothing from AGPL-licensed projects).
- A new provider needs: the module under `src/providers/<id>/`, registry entry, unit tests with scripted replies,
  stand-in routes in `src/standin/standin.ts`, a case in `test/e2e.test.ts` and `test/tools.test.ts` (doctor), a row in
  `docs/PROVIDERS.md` and a section in `docs/REAL-TEST.md`. Mark it "never real" until someone has run the real test.
- No real network calls in tests. `test/e2e.test.ts` fails on any non-loopback request.

## Leak scan

`test/leak-scan.test.mjs` fails when the tree contains private-range IPs, token-shaped strings, non-synthetic UUIDs
(use `00000000-0000-4000-8000-…`), URL hosts outside a public allowlist, or names from your own machine (login, host
names, `~/.ssh/config`, `/etc/hosts`). Before publishing a fork, run it in strict mode with your own private sources
(never committed):

```bash
POSTGATE_LEAK_SOURCES=/path/private.terms:/path/inventory.json POSTGATE_LEAK_STRICT=1 POSTGATE_LEAK_HISTORY=1 \
  node --test test/leak-scan.test.mjs
```
A `.terms` file is a word list (one private term per line).

## Commits

Describe the why. By contributing you agree your contribution is licensed under Apache-2.0.
