# HTTP API

Base URL: `http://127.0.0.1:8787` (compose publishes it on loopback only). JSON in and out, except media upload
(raw bytes) and the signed media route (bytes out). Every route except health and signed media needs
`Authorization: Bearer pgate_…`. The key decides the tenant.

## Keys and what they may do

| Key | Made by | Scopes | May decide approvals |
|---|---|---|---|
| owner/member key | `src/admin/bootstrap.ts` (first run) | all | yes, by role (`owner`, `admin`, `approver`) |
| automation key (agents, scripts) | `POST /v1/keys` with an owner/admin key | `drafts:read`, `drafts:write`, `approvals:request`, `schedule:write` | **never** |

An automation key cannot hold `approvals:decide` or `channels:write`; the API refuses to mint one that does.

## Errors

`{"error": "<code>", "message": "…", "detail"?: …}` with status 400 (bad request), 401 (bad key), 403 (`missing_scope`,
`human_required`, `admin_required`, `forbidden`), 404, 409 (`not_editable`, `stale`, `gate` — the database's approval gate
refused the change), 410 (approval request expired), 413, 415, 422 (`invalid_post`, `unknown_provider`, `ambiguous_channel`).

## Routes

### `GET /v1/health`
`{"ok": true}`. No key.

### `GET /v1/me`
Tenant, actor, member, role, scopes, `isHuman`, `canDecide`, `defaultTimezone`.

### `GET /v1/channels`
`{channels: [{id, provider, kind, externalId, displayName, status}], providers: [{id, displayName, limits, capabilities}]}`.
Channel `status`: `active`, `needs_reconnect` (the worker hit a 401 or a missing token), `disabled`.

### `POST /v1/channels`
Owner/admin key. `{provider, externalId, tokenEnv, displayName?, kind?, settings?}`. `tokenEnv` is the **name** of the
environment variable that holds the token in the worker's environment; the API refuses anything that is not a
variable name. Re-adding the same `provider` + `externalId` updates it and re-activates it.

### `POST /v1/channels/:id/status`
Owner/admin key. `{status: "active" | "disabled"}`. Use `active` after fixing a token for a `needs_reconnect` channel.

### `GET /v1/media`
The tenant's media (newest 200).

### `POST /v1/media`
Raw bytes; `Content-Type` is the file's MIME type (JPEG, PNG, GIF, WebP, MP4, MOV, WebM, MKV, PDF, DOC/DOCX, PPT/PPTX).
Query: `altText`, `title`. Returns `{id, kind, mime, sizeBytes, sha256}`. Needs `POSTGATE_MEDIA_DIR` (501 otherwise).

### `GET /media/:key`
`/media/<tenant>/<sha256>.<ext>?exp=…&sig=…`: a short-lived HMAC-signed link the worker hands to platforms that pull
media from a URL (Instagram, Facebook). No key; 404 when the signature is wrong or expired.

### `POST /v1/keys`
Owner/admin key. `{name, scopes?, expiresInDays?}` → `{id, key, scopes}`; the key is shown once.

### `GET /v1/posts`
Query: `status` (comma list), `from`/`to` (ISO, on `scheduledAt`), `limit`. Newest first, or by time when ranged.

### `POST /v1/drafts`
```json
{ "body": "text", "title": "optional", "linkUrl": "optional", "mediaIds": ["uuid"],
  "targets": [ { "provider": "linkedin", "bodyOverride": "per-channel variant", "settings": { "firstComment": "…" } },
               { "channelId": "uuid" } ],
  "scheduledAt": "2026-11-20T09:30", "timezone": "Europe/Berlin", "sourceRef": "rss:123" }
```
A target names a `channelId`, or a `provider` when the tenant has exactly one active channel of it. `sourceRef` makes
creation idempotent. Returns `{postId, created, issues: [{channelId, provider, issues: [{field, code, message}]}]}`
(201, or 200 when `sourceRef` matched). Settings per provider are in `docs/PROVIDERS.md`.

### `GET /v1/posts/:id`
The post, its targets (`status`, `externalUrl`, `publishedAt`, `deletedAt`, `lastError`), its latest approval and history.

### `PATCH /v1/posts/:id`
Any of `title`, `body`, `linkUrl`, `mediaIds`, `targets` (the full set). Any content edit voids the approval and returns
the post to `draft`.

### `DELETE /v1/posts/:id`
Member key. Drafts only.

### `POST /v1/posts/:id/validate`
`{issues: …}` as in drafts.

### `POST /v1/posts/:id/approval-requests`
`{via?: ["console"|"chat"|"email"|"api"], ttlHours?}` → `{approvalId, approvalToken, contentHash, status: "in_review"}`.
Refused with 422 while any target has validation issues. `approvalToken` is a one-time token for a relay (chat, e-mail
link) that lets a human decide with `POST /v1/approvals/decide`; only its SHA-256 is stored.

### `POST /v1/posts/:id/decision`
Human member key with an approver role. `{decision: "approved" | "rejected", note?}`. Approves the pending request for
the post's **current** content hash. If the post has a time, it becomes `scheduled`, otherwise `approved`.

### `POST /v1/approvals/decide`
`{token, actor, decision, via?, note?}`: decide by one-time token. Needs `approvals:decide`; a member key decides only
as its own member; `agent:` / `system:` actors are refused.

### `POST /v1/posts/:id/schedule`
`{at, timezone?}`. Before approval this only proposes the time. An approved post becomes `scheduled`. Moving the time
keeps the approval (the approval covers the content, not the time). Times more than a minute in the past are refused.

### `POST /v1/posts/:id/unschedule`
Removes the time; an approved post stays approved.

### `POST /v1/posts/:id/cancel`
Member key. Stops every target not yet published.

### `POST /v1/posts/:id/retry`
Member key. Re-queues `failed` / `needs_attention` targets on active channels (still gated by the approval).

### `POST /v1/posts/:id/unpublish`
Member key. Queues a `delete_target` job for every published target; the worker deletes each live post on its platform.
Instagram media cannot be deleted through the API: that target records `post_target.delete_failed` (delete it in the app).
