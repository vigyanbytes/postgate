# Providers: what exists and how far it is proven

**Honest status, read this first.** Every provider below is written from the platform's public documentation (links in
the header of each `src/providers/<name>/index.ts`) and is tested against scripted mocks and against the local
stand-in servers in `src/standin/`. **None has ever sent a real post.** A stand-in passing proves our request building,
ordering, retries and error handling; it cannot prove that a real platform accepts the request (app review, scopes,
account type, media rules, API tier). `docs/REAL-TEST.md` is the step-by-step for the first real post per network.

| Provider id | What it posts | Built | Unit tests (mocks) | End-to-end vs stand-in | Real network |
|---|---|---|---|---|---|
| `linkedin` | personal profile: text, link, 1–20 images, 1 video, 1 document; first comment | yes | yes | yes | **never** |
| `linkedin_page` | company Page: same as above; reconcile after unknown outcome | yes | yes | yes | **never** (needs Community Management API approval) |
| `facebook_page` | Page: text, link, 1–10 images, 1 video; first comment | yes | yes | yes | **never** |
| `instagram` | professional account: 1 image/Reel, carousel up to 10; first comment | yes | yes | yes | **never** (needs a public media URL) |
| `youtube` | one video (or Short) per post, private by default; first comment | yes | yes | yes | **never** |
| `x` | text, up to 4 images or 1 video, threads; first reply | yes | yes | yes | **never** (needs an API tier that allows posting) |

Not built: Threads, TikTok, Pinterest, Bluesky, Mastodon, Telegram, Reddit, Google Business Profile, YouTube community posts
(no public API). The provider interface (`src/providers/types.ts`) is small; a new network is one module plus tests.

## Per-target settings

| Provider | `settings` keys |
|---|---|
| all that support it | `firstComment` (text posted as a comment/reply right after publishing) |
| `linkedin` | `visibility`: `PUBLIC` (default) or `CONNECTIONS` (personal only) |
| `instagram` | `shareToFeed` (Reels, default true) |
| `youtube` | `title` (required), `privacyStatus` `private` (default) / `unlisted` / `public`, `tags`, `categoryId`, `madeForKids`, `shorts` |
| `x` | `thread`: list of follow-up texts posted as a reply chain |

Channel-level `settings` (`postgate channel add` → API `settings`): `linkedinVersion` overrides the pinned `LinkedIn-Version`.

## Pinned API versions

| Platform | Version | Sunset | Where |
|---|---|---|---|
| LinkedIn | `202610` | 2027-10-15 (Marketing API migrations page, checked 2026-11-10) | `src/providers/linkedin/index.ts` |
| Meta Graph (Facebook, Instagram) | `v24.0` | estimated 2027-10-01 | `src/providers/meta/graph.ts` |

A test fails when a pinned version is within 60 days of its sunset; `postgate doctor` warns too.

## What the worker does with errors

| Error kind | Meaning | Worker |
|---|---|---|
| `retryable` | nothing was created (429, 5xx on a read, network before send) | back to the queue with exponential backoff + jitter; the platform's Retry-After wins |
| `reconnect` | token unusable (401, revoked, expired without refresh) | channel → `needs_reconnect`, target → `needs_attention` |
| `fatal` | retrying cannot help (validation, 400/403/422, version sunset) | target → `failed` |
| `unknown_outcome` | a create call may have succeeded (timeout or 5xx on POST) | next attempt **looks the post up** (reconcile) instead of posting again; if it cannot (LinkedIn personal), `needs_attention` for a human |

Jobs that exhaust their attempts become `dead` and stay in `social.jobs` for inspection.
