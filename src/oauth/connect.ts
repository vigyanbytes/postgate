// `postgate oauth <provider>`: get a user token for a channel with the provider's own OAuth flow, on this machine.
//   1. reads the platform app's client id/secret from environment variables (by NAME; defaults per provider)
//   2. listens on http://127.0.0.1:<port>/callback (loopback only) and prints the authorize URL to open in a browser
//   3. checks `state`, exchanges the code (PKCE for X) and writes one token file per account to --out (mode 0600)
// Tokens are never printed. Each file holds a JSON token set, which is what a channel's token variable may contain:
//   export LINKEDIN_MEMBER_TOKEN="$(cat <file>)"
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serializeToken } from '../credentials/store.ts';
import type { HttpClient } from '../providers/http.ts';
import type { ProviderRegistry } from '../providers/registry.ts';

export interface OAuthOptions {
  provider: string;
  registry: ProviderRegistry;
  env: Record<string, string | undefined>;
  http: HttpClient;
  outDir: string;
  port?: number;
  /** When the platform requires a different (e.g. https) redirect URI that forwards to the local listener. */
  redirectUri?: string;
  clientIdEnv?: string;
  clientSecretEnv?: string;
  /** Called with the URL the human must open. */
  onAuthorizeUrl(url: string, redirectUri: string): void;
  timeoutMs?: number;
}

export interface OAuthResult { files: { path: string; externalId: string; displayName: string; kind: string }[] }

const b64url = (b: Buffer) => b.toString('base64url');
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

export async function oauthConnect(o: OAuthOptions): Promise<OAuthResult> {
  if (!o.registry.has(o.provider)) throw new Error(`unknown provider ${o.provider}`);
  const p = o.registry.get(o.provider);
  const idEnv = o.clientIdEnv ?? p.auth.secretNames.clientId ?? '';
  const secretEnv = o.clientSecretEnv ?? p.auth.secretNames.clientSecret ?? '';
  const clientId = o.env[idEnv];
  const clientSecret = o.env[secretEnv];
  if (!clientId || !clientSecret) throw new Error(`set $${idEnv} and $${secretEnv} (your ${p.displayName} app's client id and secret) first`);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  let resolveCode!: (code: string) => void;
  let rejectCode!: (e: Error) => void;
  const gotCode = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
    const err = u.searchParams.get('error');
    const stateOk = u.searchParams.get('state') === state;
    const code = u.searchParams.get('code');
    const ok = !err && stateOk && Boolean(code);
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(ok ? 'Connected. You can close this tab and return to the terminal.' : 'Authorization failed; see the terminal.');
    if (err) rejectCode(new Error(`the platform returned error=${err} ${u.searchParams.get('error_description') ?? ''}`.trim()));
    else if (!stateOk) rejectCode(new Error('state mismatch: refusing this callback'));
    else if (ok) resolveCode(String(code));
  });
  await new Promise<void>((r) => server.listen(o.port ?? 8789, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = o.redirectUri ?? `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => rejectCode(new Error('timed out waiting for the browser callback')), o.timeoutMs ?? 10 * 60_000);
  try {
    o.onAuthorizeUrl(p.authorizeUrl({ clientId, redirectUri, state, ...(p.id === 'x' ? { codeChallenge: challenge } : {}) }), redirectUri);
    const code = await gotCode;
    const r = await p.exchangeCode({ clientId, clientSecret, redirectUri, code, http: o.http, now: () => new Date(),
      ...(p.id === 'x' ? { codeVerifier: verifier } : {}) });
    await mkdir(o.outDir, { recursive: true, mode: 0o700 });
    const files: OAuthResult['files'] = [];
    for (const a of r.accounts) {
      const path = join(o.outDir, `${p.id}-${safe(a.externalId)}.token.json`);
      await writeFile(path, serializeToken(a.token ?? r.token) + '\n', { mode: 0o600 });
      await chmod(path, 0o600);
      files.push({ path, externalId: a.externalId, displayName: a.displayName, kind: a.kind });
    }
    return { files };
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}
