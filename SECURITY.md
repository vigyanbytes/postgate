# Security

## Design

- **Human approval is enforced by the database.** Triggers refuse to queue or publish content without an approval for
  its current hash; the worker re-checks before every platform call. Automation keys (agents) cannot decide approvals.
- **Tenant isolation** by forced row-level security on every table; the API and worker run as separate least-privilege
  roles; the API role cannot read credentials or jobs.
- **Secrets by name.** Channels store the name of an environment variable, or an envelope-encrypted token. API keys
  are stored as SHA-256 only and shown once. HTTP errors and logs redact tokens (`Bearer ***`, `access_token=***`).
- **Loopback by default.** The API binds 127.0.0.1 and refuses all-interfaces binds unless explicitly allowed;
  compose publishes it on 127.0.0.1 only. Put a TLS reverse proxy in front before exposing it, and expose only the
  `/media/` route when a platform must download media (signed, short-lived URLs).
- **Stand-in mode cannot redirect traffic off the machine**: `POSTGATE_STANDIN_URL` must be a loopback URL.
- `postgate oauth` listens on 127.0.0.1 only, checks `state`, uses PKCE where the platform supports it, writes token
  files with mode 0600 and never prints tokens.

## Operating it

- Keep `.env` out of version control (it is in `.gitignore`); prefer your secret manager's injection over files.
- Rotate a channel token by changing its variable and restarting the worker; re-activate the channel with
  `postgate channel enable <id>` if it was marked `needs_reconnect`.
- Revoke an API key: `update social.api_keys set revoked_at = now() where id = …` (a CLI command is planned).

## Reporting a vulnerability

Please report privately through the repository's security advisories rather than a public issue. Include steps to
reproduce and the version or commit. We aim to acknowledge within a week.
