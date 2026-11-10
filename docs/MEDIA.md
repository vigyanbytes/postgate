# AI media (v1: avatar video with HeyGen)

A media job turns a script into a video asset that a post can carry. It never publishes anything: the video is
attached to a draft, and the draft goes through the same human approval as any post.

```
postgate video avatar --script … --avatar <look id> --consent "…" --post <draft id>
      │ API: needs media:generate, records who asked and the consent statement, queues a media_job
      ▼
worker: mark running (committed) → POST /v3/videos (x-api-key from $HEYGEN_API_TOKEN) → video_id
      → every 15 s: GET /v3/videos/{id}  pending|processing → poll again (up to 1 hour)
                                         completed → download video_url (short-lived) → media storage → media asset
                                                     → appended to the draft (approval voided, back to draft)
                                         failed → job failed with HeyGen's failure_code/message
```

| Rule | Why |
|---|---|
| `media:generate` is a separate scope, not in automation keys by default | generation spends money |
| `consent` is required on every job | animating a real person's face or voice needs their agreement; use `stock avatar` for HeyGen's stock avatars |
| the key is read from an environment variable by NAME (`HEYGEN_API_TOKEN`, or a per-tenant name set by an owner/admin) | the database, logs and events never see it; each tenant can bring its own key |
| a create call with an unknown outcome (timeout, 5xx) is not retried | a retry could create and bill a second video; check the HeyGen dashboard |
| rate limits (429) retry after `Retry-After`; 401/402/400/404 fail the job | a human must fix the key, credits, avatar or script |
| `usage` on the job records what HeyGen reported (duration) | metering per tenant |

Status of the HeyGen integration: written from HeyGen's public v3 docs (v1/v2 reached end of support on 2026-10-31)
and tested only against the stand-in in `src/standin/standin.ts`. **No real HeyGen video has been generated.**
HeyGen has no free test mode; the first real video is in `docs/REAL-TEST.md`.

Not built yet: webhooks (`callback_url`) instead of polling, voice cloning, video translation/dubbing, other providers,
spend caps. The provider interface is `src/media/types.ts`.
