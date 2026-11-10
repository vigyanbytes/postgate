# First real post, per network (for the operator)

Nothing in this repository has ever posted to a real network. These steps are for a person to run, one network at a
time, with a test account or a test Page wherever the platform allows it. Each network follows the same seven steps;
the per-network sections below give the app setup and the details that differ.

**Rules for the whole test**
- Tokens and app secrets live only in your secret store and in the environment of the process that needs them. They are
  passed **by variable name** (`--token-env`), never typed into a command line, a draft or a chat with an agent.
- Use an obviously-test text (e.g. `postgate test – please ignore – <date>`), the least public visibility the platform
  offers, and delete the post right after verifying it.
- One network per session. If anything is unexpected, stop: `postgate cancel <post>` stops everything not yet sent.

## The seven steps (every network)

0. **Stack running** (`docker compose up -d`), owner key in `POSTGATE_KEY`, `POSTGATE_URL=http://127.0.0.1:8787`.
   Put the channel token variable (and, for refresh, the app credential variables) in `.env`, then
   `docker compose up -d worker` so the worker sees them. Your shell needs the token variable too for `doctor`.
1. **Get a token**: `postgate oauth <provider> --out ~/.postgate-tokens` (needs the app's client id/secret variables;
   see each section for the redirect URI to register). It prints the account id(s) and writes one `0600` token file per
   account; it never prints a token. Load it where needed: `export <VAR>="$(cat <file>)"` and add the same line's value
   to `.env` through your secret manager.
2. **Dry run (sends nothing)**:
   `postgate doctor --provider <p> --external-id <id> --token-env <VAR> --text "postgate test – please ignore"` (add
   `--media FILE` and `--setting key=value` as in the section). Every check must be `ok`; read the printed requests.
3. **Live token check (one read-only GET)**: same command plus `--live`. It must say `token works as <your account>`.
4. **Connect the channel**: `postgate channel add --provider <p> --external-id <id> --token-env <VAR> --name "<label>"`.
5. **Draft → approval → schedule**:
   ```bash
   postgate draft --body "postgate test – please ignore – $(date -u +%F)" --target <p> [--media ID] [--setting <p>.key=value]
   postgate request-approval <post-id>          # (an agent with an automation key can do the steps up to here)
   postgate post <post-id>                      # read exactly what will go out
   postgate approve <post-id>                   # human member key only
   postgate schedule <post-id> --at "$(date -u -d '+2 minutes' +%Y-%m-%dT%H:%M:%SZ)"
   ```
6. **Verify**: within a minute after the time, `postgate post <post-id>` shows the target `published` with its
   `externalUrl`. Open the URL logged in as the account; check text, media, visibility. `docker compose logs worker`
   shows the job. On `failed` / `needs_attention`, `lastError` names the platform's answer.
7. **Delete and record**: `postgate unpublish <post-id>`, then `postgate post <post-id>` shows `(deleted)`; reload the
   URL to confirm it is gone. Note in your log: date, network, account, post id, external URL, deleted yes/no, anything
   surprising. Revoke the test token afterwards if it was created only for the test.

## LinkedIn — personal profile (`linkedin`)

- **App**: LinkedIn developer portal → create an app (it must be linked to a LinkedIn Page you admin) → Products: add
  **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** (self-serve). Auth tab: add the redirect URL
  `http://127.0.0.1:8789/callback` (if the portal refuses an http loopback URL, use an https URL you control that
  forwards to it and pass `--redirect-uri`). Variables: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`.
- **Token**: `postgate oauth linkedin --out ~/.postgate-tokens`. Scopes `openid profile w_member_social`. Lives 60 days,
  **no refresh token** for self-serve apps: repeat the oauth step before it expires.
- **External id**: `urn:li:person:<sub>` (printed by the oauth step).
- **Test post**: text only first; least public: `--setting linkedin.visibility=CONNECTIONS`.
- **Verify**: the URL is `https://www.linkedin.com/feed/update/<urn>/`.
- **Delete**: `postgate unpublish` (DELETE on the Posts API). If it fails, delete it from the post's menu.
- **Known limit**: a personal post cannot be looked up again through the API, so after a timeout the worker parks the
  target as `needs_attention` instead of retrying; check the profile by hand, then `retry` only if it is not there.

## LinkedIn — company Page (`linkedin_page`)

- **App**: same app plus the **Community Management API** product, which LinkedIn must approve (application form,
  use-case review). Without it the oauth step fails with missing scopes. Scopes: `w_organization_social
  r_organization_social rw_organization_admin`. You must be an ADMINISTRATOR of the Page.
- **Token**: `postgate oauth linkedin_page --out …` lists the Pages you administer (`urn:li:organization:<n>`). Tokens
  from approved apps carry a refresh token; keep `LINKEDIN_CLIENT_ID/SECRET` in the worker environment for refresh.
- **Test post / verify / delete**: as personal (visibility is always public for Pages; use a test Page if you have one).

## Facebook Page (`facebook_page`)

- **App**: Meta for Developers → create an app (type Business) → add **Facebook Login for Business** → Valid OAuth
  Redirect URIs: `http://127.0.0.1:8789/callback` (Meta allows localhost redirects while the app is in development
  mode). Permissions: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `pages_manage_engagement`. In
  development mode they work without App Review for people with a role on the app (add yourself as admin/tester).
  Variables: `META_APP_ID`, `META_APP_SECRET`.
- **Token**: `postgate oauth facebook_page --out …` writes one file **per Page** with that Page's own token (derived
  from a long-lived user token, so it does not expire unless revoked). Use the Page file, not a user token.
- **External id**: the numeric Page id.
- **Test post**: text only (no media means no public media URL needed). With media, see Instagram's media note.
- **Verify / delete**: URL `https://www.facebook.com/<post id>`; `postgate unpublish` deletes it.

## Instagram (`instagram`)

- **Account**: a professional (Business or Creator) account. A throwaway test account is strongly advised: posts can
  **not** be deleted through the API.
- **App**: Meta app → add the **Instagram** product → *API setup with Instagram login* → add the redirect URI
  (Instagram requires it to be registered exactly; if http loopback is refused, use an https URL you control that
  forwards to `127.0.0.1:8789/callback`). Permissions: `instagram_business_basic`, `instagram_business_content_publish`
  (+ `instagram_business_manage_comments` for first comments). Variables: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`.
- **Token**: `postgate oauth instagram --out …` (long-lived, 60 days, refreshable; keep the app variables in the worker).
- **Media is mandatory and Instagram downloads it from a URL**: set `POSTGATE_PUBLIC_URL` to an https base that
  reaches this API's `/media/` route from the internet (your reverse proxy or a tunnel you trust) and
  `POSTGATE_MEDIA_URL_SECRET` (random, ≥ 16 chars) in `.env` for both api and worker; restart them. Check from outside:
  the doctor output shows the URL shape. JPEG only for images.
- **Test post**: `postgate media upload test.jpg --alt "test"` then draft with `--media <id>`.
- **Verify**: the permalink in `externalUrl`.
- **Delete**: `postgate unpublish` records `delete_failed` for Instagram (no API): delete it in the Instagram app.
  Publishing limit: 100 API posts per 24 h.

## YouTube (`youtube`)

- **Project**: Google Cloud console → new project → enable **YouTube Data API v3** → OAuth consent screen (External,
  Testing; add your Google account as a test user) → Credentials → OAuth client ID of type **Desktop app** (loopback
  redirects on any port are allowed for it). Variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- **Token**: `postgate oauth youtube --out …` (access 1 h + refresh token; keep the app variables in the worker so it
  can refresh). Scopes: `youtube.upload`, `youtube.readonly`, `youtube.force-ssl`.
- **External id**: the `UC…` channel id (printed by the oauth step).
- **Test post**: a short MP4; `--setting youtube.title="postgate test" --setting youtube.privacyStatus=private`.
  Uploads are private by default, and projects that have not passed Google's API audit are forced private anyway.
  An upload costs a large share of the default daily quota (see the quota page in the Cloud console).
- **Verify**: `https://www.youtube.com/watch?v=<id>` while signed in (it is private).
- **Delete**: `postgate unpublish` (videos.delete), or delete in YouTube Studio.

## X (`x`)

- **Access**: an X developer account on a tier that allows `POST /2/tweets` and media upload for your volume; check
  your plan in the developer console before testing.
- **App**: in the app's *User authentication settings*: OAuth 2.0, type *Web App, Automated App or Bot*, permissions
  *Read and write*, callback `http://127.0.0.1:8789/callback`. Variables: `X_CLIENT_ID`, `X_CLIENT_SECRET`.
- **Token**: `postgate oauth x --out …` (PKCE; scopes `tweet.read tweet.write users.read media.write offline.access`;
  access 2 h, refresh token rotates on every refresh — keep the app variables in the worker).
- **External id**: the numeric user id (printed by the oauth step).
- **Test post**: text only first; X rejects an identical text posted twice, so include the date.
- **Verify / delete**: `https://x.com/i/web/status/<id>`; `postgate unpublish` deletes the head post (thread replies, if
  you used `thread`, are deleted by hand).

## Optional rehearsal with the stand-ins first

To walk the exact same commands without any network: stop the compose worker (`docker compose stop worker`), run
`postgate standin --port 8790` in one terminal and, from the checkout, a worker in another:
`DATABASE_URL=postgres://postgate:<password>@127.0.0.1:<db port>/postgate POSTGATE_STANDIN_URL=http://127.0.0.1:8790 npm run worker`
(publish the db port in a compose override for this). The stand-in URL must be loopback; the worker refuses anything
else. Posts land at `http://127.0.0.1:8790/__standin/posts`. Start the compose worker again for the real test.
