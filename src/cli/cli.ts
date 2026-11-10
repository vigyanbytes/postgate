// postgate CLI. API commands talk to a running API (POSTGATE_URL + POSTGATE_KEY); the key decides what is allowed:
// an automation key can draft, upload media, ask for approval and set times, never approve. Approving needs a human
// member's key (owner/admin/approver). Local commands (doctor, oauth, standin) need no API.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ApiError, apiClient, mimeOfPath, type FetchFn, type Request } from '../client/api.ts';
import { doctor, whoami, type DoctorMedia } from '../doctor/doctor.ts';
import { oauthConnect } from '../oauth/connect.ts';
import { httpClient } from '../providers/http.ts';
import { defaultRegistry } from '../providers/registry.ts';
import { kindOfMime } from '../media/storage.ts';
import { heygenList } from '../media/heygen.ts';
import { createStandin, startStandinServer } from '../standin/standin.ts';

export interface Io {
  env: Record<string, string | undefined>;
  fetch: FetchFn;
  out(s: string): void;
  err(s: string): void;
  readBytes(path: string): Promise<Uint8Array>;
  /** Long-running commands (standin) resolve this when they should stop. */
  untilStopped?: () => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const HELP = `postgate — schedule social posts behind a human approval gate

API (needs POSTGATE_URL and POSTGATE_KEY):
  postgate me | channels | posts [--status draft,in_review] | post ID
  postgate channel add --provider P --external-id ID --token-env VAR [--name NAME]     (owner/admin key)
  postgate channel enable|disable CHANNEL_ID                                           (owner/admin key)
  postgate media upload FILE [--alt TEXT] [--title TEXT]
  postgate draft --body TEXT --target P|CHANNEL_ID [--target …] [--variant P=TEXT] [--setting P.key=JSON]
                 [--media MEDIA_ID …] [--title T] [--link URL] [--at TIME [--tz ZONE]] [--source-ref REF]
  postgate validate ID
  postgate request-approval ID [--via console|chat|email|api]
  postgate approve ID [--note TEXT] | reject ID [--note TEXT]                          (human member key)
  postgate schedule ID --at TIME [--tz ZONE] | unschedule ID
  postgate cancel ID | retry ID | delete ID                                            (member key)
  postgate unpublish ID      remove the live copies from the platforms again        (member key)
  postgate key create NAME [--days N] [--scope media:generate]   automation key for an agent/script (owner/admin key)

AI video (costs provider credits; the video joins the draft and still needs approval):
  postgate video avatar --script TEXT --avatar ID --consent "WHO agreed | stock avatar" [--voice ID] [--post ID]
                        [--aspect 16:9|9:16|1:1|4:5|5:4] [--resolution 720p|1080p] [--title T] [--key-env VAR]
  postgate video status JOB_ID
  postgate heygen avatars|voices           list ids (local; reads $HEYGEN_API_TOKEN, read-only)

Local (no API):
  postgate doctor --provider P --external-id ID --token-env VAR [--text T] [--media FILE …] [--title T]
                  [--link URL] [--setting key=JSON …] [--live]
        checks the configuration and prints the exact requests a publish would send; sends nothing
        (--live adds ONE read-only request to the platform to prove the token)
  postgate oauth P --out DIR [--port 8789] [--redirect-uri URI] [--client-id-env VAR] [--client-secret-env VAR]
  postgate standin [--port 8790]           local stand-in of every platform API (rehearsals)

TIME is ISO 8601 with an offset (2026-11-20T09:30:00+01:00) or local wall-clock (2026-11-20T09:30) in --tz.
Add --json to print the raw response. Providers: linkedin, linkedin_page, facebook_page, instagram, youtube, x.`;

export class UsageError extends Error {}

const BOOL = new Set(['json', 'live']);
function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOL.has(name)) { flags[name] = ['1']; continue; }
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      (flags[name] ??= []).push(v);
      i++;
    } else pos.push(a);
  }
  const one = (k: string) => flags[k]?.at(-1);
  const all = (k: string) => flags[k] ?? [];
  return { pos, flags, one, all, json: Boolean(flags.json) };
}

const short = (s: unknown, n = 70) => { const t = String(s ?? '').replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const id = (v: string | undefined, what = 'post id') => {
  if (!v || !UUID.test(v)) throw new UsageError(`needs a ${what} (uuid)`);
  return v;
};
const json = (v: string, what: string) => { try { return JSON.parse(v); } catch { return v; } };

function parseKv(list: string[], what: string): [string, string, unknown][] {
  // P.key=JSON for targets, key=JSON for doctor; JSON falls back to a plain string.
  return list.map((s) => {
    const eq = s.indexOf('=');
    if (eq < 1) throw new UsageError(`${what} must look like name=value`);
    const left = s.slice(0, eq);
    const dot = left.indexOf('.');
    return dot > 0 ? [left.slice(0, dot), left.slice(dot + 1), json(s.slice(eq + 1), what)] : ['', left, json(s.slice(eq + 1), what)];
  });
}

function readable(verb: string, sub: string | undefined, j: any): string {
  switch (verb) {
    case 'me': return `tenant ${j.tenant?.slug} · ${j.isHuman ? `member ${j.member} (${j.role})` : 'automation key'} · can approve: ${j.canDecide ? 'yes' : 'no'}\nscopes: ${(j.scopes ?? []).join(', ')}`;
    case 'channels': return (j.channels ?? []).map((c: any) => `${String(c.status).padEnd(15)} ${c.provider.padEnd(14)} ${short(c.displayName, 30).padEnd(30)} ${c.externalId}  ${c.id}`).join('\n') || 'No channels yet: postgate channel add …';
    case 'channel': return sub === 'add' ? `Channel ${j.id} (${j.provider} ${j.externalId}) reads its token from $${j.tokenEnv}. Check it: postgate doctor --provider ${j.provider} --external-id ${j.externalId} --token-env ${j.tokenEnv}` : `Channel ${j.id} is ${j.status}.`;
    case 'media': return `Media ${j.id} (${j.kind}, ${j.sizeBytes} bytes). Use it: postgate draft … --media ${j.id}`;
    case 'posts': return (j.posts ?? []).map((p: any) => `${String(p.status).padEnd(17)} ${(p.scheduledLocal ?? '').padEnd(25)} ${short(p.title ?? p.excerpt, 50).padEnd(50)} ${(p.providers ?? []).join(',')}  ${p.id}`).join('\n') || 'No posts.';
    case 'post': return [`${j.id}  ${j.status}${j.scheduledLocal ? `  at ${j.scheduledLocal}` : ''}`, short(j.body, 200),
      ...(j.targets ?? []).map((t: any) => `  ${t.provider.padEnd(14)} ${String(t.status).padEnd(16)} ${t.externalUrl ?? ''}${t.deletedAt ? ' (deleted)' : ''}${t.lastError ? ` ${short(JSON.stringify(t.lastError), 100)}` : ''}`),
      `approval: ${j.approval ? j.approval.status : 'none'}`].join('\n');
    case 'draft': {
      const n = (j.issues ?? []).reduce((k: number, t: any) => k + (t.issues?.length ?? 0), 0);
      return `Draft ${j.postId} ${j.created ? 'created' : 'already existed'}; ${n} validation issue(s).${n ? '' : ` Next: postgate request-approval ${j.postId}`}` +
        (n ? `\n${(j.issues ?? []).flatMap((t: any) => (t.issues ?? []).map((i: any) => `  ${t.provider}: ${i.field} ${i.code} — ${i.message}`)).join('\n')}` : '');
    }
    case 'validate': return (j.issues ?? []).flatMap((t: any) => t.issues.length ? t.issues.map((i: any) => `${t.provider}: ${i.field} ${i.code} — ${i.message}`) : [`${t.provider}: ok`]).join('\n');
    case 'request-approval': return `Approval requested (${j.approvalId}); the post is ${j.status}. A human approver runs: postgate approve <post id>`;
    case 'approve': case 'reject': return `Post is now ${j.postStatus}.${j.postStatus === 'approved' ? ' Not scheduled yet: postgate schedule <id> --at TIME' : ''}`;
    case 'schedule': return `Post ${j.postId} is ${j.status} for ${j.scheduledLocal}${j.status === 'scheduled' ? '' : ' (takes effect once approved)'}.`;
    case 'video': return sub === 'status'
      ? `${j.id}  ${j.status}${j.assetId ? `  media ${j.assetId}` : ''}${j.postId ? `  post ${j.postId}` : ''}${j.error ? `  ${JSON.stringify(j.error)}` : ''}`
      : `Video job ${j.id} queued (${j.provider}). Check: postgate video status ${j.id}`;
    case 'key': return `Automation key (shown once, keep it secret): ${j.key}\nscopes: ${(j.scopes ?? []).join(', ')}`;
    default: return JSON.stringify(j, null, 2);
  }
}

async function apiCommand(a: ReturnType<typeof parse>, io: Io, req: Request): Promise<any> {
  const [verb, sub, arg] = a.pos;
  switch (verb) {
    case 'me': return req('GET', '/v1/me');
    case 'channels': return req('GET', '/v1/channels');
    case 'channel':
      if (sub === 'add') {
        const provider = a.one('provider'); const externalId = a.one('external-id'); const tokenEnv = a.one('token-env');
        if (!provider || !externalId || !tokenEnv) throw new UsageError('channel add needs --provider, --external-id and --token-env');
        return req('POST', '/v1/channels', { body: { provider, externalId, tokenEnv, ...(a.one('name') ? { displayName: a.one('name') } : {}),
          ...(a.one('kind') ? { kind: a.one('kind') } : {}) } });
      }
      if (sub === 'enable' || sub === 'disable') return req('POST', `/v1/channels/${id(arg, 'channel id')}/status`, { body: { status: sub === 'enable' ? 'active' : 'disabled' } });
      throw new UsageError('channel add | enable | disable');
    case 'media': {
      if (sub !== 'upload' || !arg) throw new UsageError('media upload FILE');
      const mime = mimeOfPath(arg);
      if (!mime || !kindOfMime(mime)) throw new UsageError(`unsupported file type: ${basename(arg)}`);
      return req('POST', '/v1/media', { query: { altText: a.one('alt'), title: a.one('title') }, raw: { bytes: await io.readBytes(arg), contentType: mime } });
    }
    case 'posts': return req('GET', '/v1/posts', { query: { status: a.one('status'), limit: a.one('limit') } });
    case 'post': return req('GET', `/v1/posts/${id(sub)}`);
    case 'draft': {
      const body = a.one('body');
      const targets = a.all('target');
      if (body === undefined) throw new UsageError('draft needs --body');
      if (!targets.length) throw new UsageError('draft needs at least one --target (provider id or channel uuid)');
      const variants = new Map(a.all('variant').map((v) => { const eq = v.indexOf('='); if (eq < 1) throw new UsageError('--variant P=TEXT'); return [v.slice(0, eq), v.slice(eq + 1)] as const; }));
      const settings = parseKv(a.all('setting'), '--setting');
      return req('POST', '/v1/drafts', { body: {
        body, ...(a.one('title') ? { title: a.one('title') } : {}), ...(a.one('link') ? { linkUrl: a.one('link') } : {}),
        ...(a.one('source-ref') ? { sourceRef: a.one('source-ref') } : {}), ...(a.all('media').length ? { mediaIds: a.all('media') } : {}),
        ...(a.one('at') ? { scheduledAt: a.one('at') } : {}), ...(a.one('tz') ? { timezone: a.one('tz') } : {}),
        targets: targets.map((t) => {
          const s = Object.fromEntries(settings.filter(([p]) => p === t).map(([, k, v]) => [k, v]));
          return { ...(UUID.test(t) ? { channelId: t } : { provider: t }), ...(variants.has(t) ? { bodyOverride: variants.get(t) } : {}),
            ...(Object.keys(s).length ? { settings: s } : {}) };
        }) } });
    }
    case 'validate': return req('POST', `/v1/posts/${id(sub)}/validate`);
    case 'request-approval': return req('POST', `/v1/posts/${id(sub)}/approval-requests`, { body: a.all('via').length ? { via: a.all('via') } : {} });
    case 'approve': case 'reject':
      return req('POST', `/v1/posts/${id(sub)}/decision`, { body: { decision: verb === 'approve' ? 'approved' : 'rejected', ...(a.one('note') ? { note: a.one('note') } : {}) } });
    case 'schedule':
      if (!a.one('at')) throw new UsageError('schedule needs --at TIME');
      return req('POST', `/v1/posts/${id(sub)}/schedule`, { body: { at: a.one('at'), ...(a.one('tz') ? { timezone: a.one('tz') } : {}) } });
    case 'unschedule': case 'cancel': case 'retry': case 'unpublish': return req('POST', `/v1/posts/${id(sub)}/${verb}`);
    case 'delete': return req('DELETE', `/v1/posts/${id(sub)}`);
    case 'key':
      if (sub !== 'create' || !arg) throw new UsageError('key create NAME');
      return req('POST', '/v1/keys', { body: { name: arg, ...(a.one('days') ? { expiresInDays: Number(a.one('days')) } : {}),
        ...(a.all('scope').length ? { scopes: ['drafts:read', 'drafts:write', 'approvals:request', 'schedule:write', ...a.all('scope')] } : {}) } });
    case 'video':
      if (sub === 'status') return req('GET', `/v1/media-jobs/${id(arg, 'media job id')}`);
      if (sub === 'avatar') {
        if (!a.one('script') || !a.one('avatar') || !a.one('consent')) throw new UsageError('video avatar needs --script, --avatar and --consent');
        return req('POST', '/v1/media-jobs', { body: { capability: 'avatar_video', provider: 'heygen', script: a.one('script'), avatarId: a.one('avatar'),
          consent: a.one('consent'), ...(a.one('voice') ? { voiceId: a.one('voice') } : {}), ...(a.one('post') ? { postId: a.one('post') } : {}),
          ...(a.one('aspect') ? { aspectRatio: a.one('aspect') } : {}), ...(a.one('resolution') ? { resolution: a.one('resolution') } : {}),
          ...(a.one('title') ? { title: a.one('title') } : {}), ...(a.one('key-env') ? { keyEnv: a.one('key-env') } : {}) } });
      }
      throw new UsageError('video avatar | video status JOB_ID');
    default: throw new UsageError(`unknown command: ${a.pos.join(' ')}\n\n${HELP}`);
  }
}

async function doctorCommand(a: ReturnType<typeof parse>, io: Io): Promise<number> {
  const provider = a.one('provider'); const externalId = a.one('external-id'); const tokenEnv = a.one('token-env');
  if (!provider || !externalId || !tokenEnv) throw new UsageError('doctor needs --provider, --external-id and --token-env');
  const media: DoctorMedia[] = [];
  for (const f of a.all('media')) {
    const mime = mimeOfPath(f);
    const kind = mime ? kindOfMime(mime) : null;
    if (!mime || !kind) throw new UsageError(`unsupported file type: ${basename(f)}`);
    media.push({ bytes: await io.readBytes(f), mime, kind, name: basename(f), ...(a.one('alt') ? { altText: a.one('alt')! } : {}) });
  }
  const settings = Object.fromEntries(parseKv(a.all('setting'), '--setting').map(([, k, v]) => [k, v]));
  const r = await doctor({ provider, externalId, tokenEnv, env: io.env,
    post: { text: a.one('text') ?? 'postgate doctor: dry run', settings, media, ...(a.one('title') ? { title: a.one('title')! } : {}), ...(a.one('link') ? { linkUrl: a.one('link')! } : {}) } },
  defaultRegistry());
  let live: Awaited<ReturnType<typeof whoami>> | undefined;
  if (a.flags.live && io.env[tokenEnv]) {
    const raw = io.env[tokenEnv]!.trim();
    const token = raw.startsWith('{') ? JSON.parse(raw).accessToken ?? JSON.parse(raw).access_token : raw;
    live = await whoami(provider, externalId, token, httpClient(io.fetch));
  }
  if (a.json) { io.out(JSON.stringify({ ...r, ...(live ? { live } : {}) }, null, 2)); return r.ok && (!live || live.ok) ? 0 : 1; }
  io.out(`postgate doctor — ${r.provider} (dry run: NOTHING is sent${a.flags.live ? '; --live sends one read-only GET' : ''})\n`);
  for (const c of r.checks) io.out(`  [${c.level === 'ok' ? ' ok ' : c.level}] ${c.name}: ${c.detail}`);
  if (r.requests.length) {
    io.out(`\nRequests the worker would send (ids and upload URLs in later calls come from the stand-in's replies):`);
    r.requests.forEach((q, i) => {
      io.out(`\n  ${i + 1}. ${q.method} ${q.url}`);
      for (const [k, v] of Object.entries(q.headers)) if (!['content-length', 'connection', 'host', 'accept', 'accept-encoding', 'accept-language', 'sec-fetch-mode', 'user-agent'].includes(k)) io.out(`     ${k}: ${v}`);
      if (q.body !== undefined) io.out(`     body: ${typeof q.body === 'string' ? q.body : JSON.stringify(q.body, null, 2).replace(/\n/g, '\n     ')}`);
    });
  }
  if (live) io.out(`\n  [${live.ok ? (live.matches === false ? 'warn' : ' ok ') : 'fail'}] live token check: ${live.detail}${live.matches === false ? ` — NOT the account ${externalId}` : ''}`);
  else if (a.flags.live) io.out(`\n  [fail] live token check: $${tokenEnv} is not set`);
  return r.ok && (!live || live.ok) && !(a.flags.live && !live) ? 0 : 1;
}

export async function run(argv: string[], io: Io): Promise<number> {
  let a;
  try { a = parse(argv); } catch (e) { io.err((e as Error).message); return 2; }
  const [verb] = a.pos;
  if (!verb || verb === 'help' || verb === '--help') { io.out(HELP); return 0; }
  try {
    if (verb === 'doctor') return await doctorCommand(a, io);
    if (verb === 'oauth') {
      const provider = a.pos[1]; const out = a.one('out');
      if (!provider || !out) throw new UsageError('oauth PROVIDER --out DIR');
      const r = await oauthConnect({ provider, registry: defaultRegistry(), env: io.env, http: httpClient(io.fetch), outDir: out,
        ...(a.one('port') ? { port: Number(a.one('port')) } : {}), ...(a.one('redirect-uri') ? { redirectUri: a.one('redirect-uri')! } : {}),
        ...(a.one('client-id-env') ? { clientIdEnv: a.one('client-id-env')! } : {}), ...(a.one('client-secret-env') ? { clientSecretEnv: a.one('client-secret-env')! } : {}),
        onAuthorizeUrl: (url, redirect) => io.out(`Redirect URI (must be registered in your app): ${redirect}\nOpen this URL in a browser and approve:\n\n  ${url}\n\nWaiting for the callback…`) });
      io.out(a.json ? JSON.stringify(r, null, 2) : ['Token files written (mode 0600; never commit or paste them):',
        ...r.files.map((f) => `  ${f.kind.padEnd(8)} ${f.displayName}  external id ${f.externalId}\n           ${f.path}`),
        `Next: export <VAR>="$(cat <file>)" where the worker runs, then: postgate channel add --provider ${provider} --external-id <id> --token-env <VAR>`].join('\n'));
      return 0;
    }
    if (verb === 'heygen') {
      const what = a.pos[1];
      if (what !== 'avatars' && what !== 'voices') throw new UsageError('heygen avatars | heygen voices');
      const envName = a.one('key-env') ?? 'HEYGEN_API_TOKEN';
      const key = io.env[envName];
      if (!key) throw new UsageError(`$${envName} is not set`);
      const list = await heygenList(httpClient(io.fetch), key, what);
      io.out(a.json ? JSON.stringify(list, null, 2) : list.map((x) => `${x.id.padEnd(40)} ${x.name.padEnd(30)} ${x.extra}`).join('\n') || 'none');
      return 0;
    }
    if (verb === 'standin') {
      const s = await startStandinServer(createStandin({ pullMedia: io.fetch }), Number(a.one('port') ?? 8790));
      io.out(`Stand-in platform APIs on ${s.url} (NOT the real networks). Point a worker at it: POSTGATE_STANDIN_URL=${s.url}\nCreated posts: ${s.url}/__standin/posts`);
      await (io.untilStopped ?? (() => new Promise<void>(() => {})))();
      await s.close();
      return 0;
    }
    const req = apiClient({ baseUrl: io.env.POSTGATE_URL, key: io.env.POSTGATE_KEY, fetch: io.fetch });
    const j = await apiCommand(a, io, req);
    io.out(a.json ? JSON.stringify(j, null, 2) : readable(verb, a.pos[1], j));
    return 0;
  } catch (e) {
    if (e instanceof ApiError && e.detail) io.err(`${e.message}\n${JSON.stringify(e.detail, null, 2)}`);
    else io.err((e as Error).message);
    return e instanceof UsageError ? 2 : 1;
  }
}

export const readBytesFromDisk = async (p: string) => new Uint8Array(await readFile(p));
