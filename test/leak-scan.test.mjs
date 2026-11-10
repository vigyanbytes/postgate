// Leak scan: fails when the repository mentions anything specific to the machine, network or deployment it
// was built on (adapted from the same test in a sibling project). The forbidden list is DERIVED AT TEST TIME from private sources on the machine
// running the test and is never written to the repository:
//   - this machine: login name, host name, home directory
//   - /etc/hosts, ~/.ssh/config (Host, HostName, User), `tailscale status --json` when present
//   - every file listed in POSTGATE_LEAK_SOURCES (path-delimiter separated: inventories, env examples,
//     docs of a private deployment); IPs, URL hosts, e-mails, ssh targets, node names, home paths and
//     UUIDs (tenant ids) are pulled out of them. Files ending in .terms are word lists (one private
//     term per line: brand names, product names, logins)
// On top of that, generic rules that need no private input: no private-range IPv4 addresses,
// no tailnet names, no token-shaped strings, and every URL host must be a documentation or
// well-known public host, and every UUID must be an obviously synthetic test id (00000000-0000-…),
// so a real tenant, channel or post id cannot slip in even when no private source names it.
// POSTGATE_LEAK_STRICT=1 fails when no POSTGATE_LEAK_SOURCES were given (use it before a commit).
// POSTGATE_LEAK_HISTORY=1 also scans every line ever added in git history.
// Run: node --test test/leak-scan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { userInfo, hostname, homedir } from 'node:os';
import { join, dirname, relative, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const BINARY = /\.(png|jpg|jpeg|gif|ico|pdf|zip|gz|tgz|mp4)$/i;
const SKIP_FILES = new Set(['package-lock.json']);

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SYNTHETIC_UUID = /^00000000-0000-/;

function repoFiles(dir = ROOT) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...repoFiles(p));
    else if (!BINARY.test(e.name) && !SKIP_FILES.has(e.name)) out.push(p);
  }
  return out;
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s"'`]+@)?([a-z0-9.-]+|\[[0-9a-f:]+\])/gi;
const EMAIL = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const isDocIp = (ip) => /^(127\.|0\.0\.0\.0$|255\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(ip);
const GENERIC = new Set(['localhost', 'local', 'localdomain', 'ip6-localhost', 'ip6-loopback', 'ip6-allnodes',
  'ip6-allrouters', 'broadcasthost', 'root', 'user', 'admin', 'example.com', 'github.com', 'git', 'ubuntu',
  // ordinary words that show up as host labels everywhere; never distinctive on their own
  'host', 'hosts', 'docs', 'node', 'nodes', 'gateway', 'server', 'servers', 'search', 'site', 'mail', 'smtp', 'auth',
  'login', 'cloud', 'proxy', 'router', 'files', 'models', 'model', 'chat', 'test', 'tests', 'home', 'desktop',
  'laptop', 'build', 'http', 'https', 'none', 'true', 'false', 'null', 'default', 'config', 'local-ai']);

// ── forbidden tokens from private sources (runtime only) ─────────────────────
function deriveForbidden() {
  const words = new Set();   // matched as whole tokens
  const subs = new Set();    // matched anywhere (login name, shared host-name stems)
  const ips = new Set();
  const hosts = [];
  const addHost = (h, stem = true) => { h = String(h || '').toLowerCase().replace(/\.$/, ''); if (!h || GENERIC.has(h) || PUBLIC_HOSTS.has(h) || hostAllowed(h) || h.includes('*')) return; if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) { if (!isDocIp(h)) ips.add(h); return; } if (h.length >= 4) { words.add(h); if (stem) hosts.push(h); } };
  const addWord = (w) => { w = String(w || '').toLowerCase(); if (w.length >= 4 && !GENERIC.has(w)) words.add(w); };
  const uuids = new Set();
  const fromText = (t) => {
    for (const m of t.matchAll(UUID_RE)) if (!SYNTHETIC_UUID.test(m[0])) uuids.add(m[0].toLowerCase());
    for (const m of t.matchAll(IPV4)) if (!isDocIp(m[0])) ips.add(m[0]);
    for (const m of t.matchAll(URL_HOST)) addHost(m[1], false);   // URL hosts: exact only, no stems
    for (const m of t.matchAll(EMAIL)) { addWord(m[0]); addWord(m[0].split('@')[0]); }
    for (const m of t.matchAll(/\/home\/([a-z0-9._-]+)/gi)) addWord(`/home/${m[1]}`);
    for (const m of t.matchAll(/\b([a-z0-9._-]+)@([a-z0-9.-]+)\b/gi)) { addWord(m[1]); addHost(m[2], false); }
  };
  const fromJson = (v, key = '') => {
    if (typeof v === 'string') {
      fromText(v);
      if (['name', 'ssh', 'host', 'hostname', 'user', 'username', 'controller'].includes(key) && v !== 'local') addHost(v.includes('@') ? v.split('@')[1] : v);
      if (['user', 'username'].includes(key)) addWord(v);
    } else if (Array.isArray(v)) v.forEach((x) => fromJson(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) fromJson(x, k.toLowerCase());
  };

  const u = userInfo().username.toLowerCase();
  if (u.length >= 3 && !GENERIC.has(u)) subs.add(u);
  addHost(hostname());
  addHost(hostname().split('.')[0]);
  addWord(homedir());
  try {
    for (const line of readFileSync('/etc/hosts', 'utf8').split('\n')) {
      const f = line.replace(/#.*/, '').trim().split(/\s+/).filter(Boolean);
      if (f.length < 2 || /^(127\.|::1|fe00|ff0)/.test(f[0])) continue;
      if (!isDocIp(f[0]) && /^(\d{1,3}\.){3}\d{1,3}$/.test(f[0])) ips.add(f[0]);
      f.slice(1).forEach(addHost);
    }
  } catch { /* no hosts file */ }
  try {
    for (const line of readFileSync(join(homedir(), '.ssh', 'config'), 'utf8').split('\n')) {
      const m = /^\s*(Host|HostName|User)\s+(.+)$/i.exec(line);
      if (!m) continue;
      for (const v of m[2].trim().split(/\s+/)) (m[1].toLowerCase() === 'user' ? addWord : addHost)(v);
    }
  } catch { /* no ssh config */ }
  const ts = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 5000 });
  if (ts.status === 0) {
    try {
      const j = JSON.parse(ts.stdout);
      if (j.MagicDNSSuffix) addHost(j.MagicDNSSuffix);
      for (const n of [j.Self, ...Object.values(j.Peer || {})].filter(Boolean)) {
        addHost(n.HostName); addHost(n.DNSName);
        for (const ip of n.TailscaleIPs || []) if (ip.includes('.')) ips.add(ip);
      }
    } catch { /* unexpected output */ }
  }
  const sources = (process.env.POSTGATE_LEAK_SOURCES || '').split(delimiter).filter(Boolean);
  for (const f of sources) {
    if (!existsSync(f) || !statSync(f).isFile()) continue;
    const t = readFileSync(f, 'utf8');
    if (f.endsWith('.terms')) {
      for (const w of t.split('\n').map((x) => x.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean)) (w.length >= 4 ? subs : words).add(w);
      continue;
    }
    let j = null;
    try { j = JSON.parse(t); } catch { /* not JSON */ }
    if (j) fromJson(j); else fromText(t);
  }
  // stems: a leading label shared by several private host names (e.g. "acme-a", "acme-b" -> "acme")
  const stems = new Map();
  for (const h of hosts) { const s = h.split(/[-.]/)[0]; if (s.length >= 4) stems.set(s, (stems.get(s) || 0) + 1); }
  for (const [s, n] of stems) if (n >= 2 && !GENERIC.has(s)) subs.add(s);
  return { words: [...words], subs: [...subs], ips: [...ips], uuids: [...uuids], sources };
}

// ── generic rules (no private input) ─────────────────────────────────────────
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/;
const SECRET_SHAPES = [/\bpgate_(?=[A-Za-z0-9_-]{40,})(?![A-Za-z0-9_-]*?(.)\1{9})[A-Za-z0-9_-]{40,}/, /\bEAA[A-Za-z0-9]{40,}/, /\bya29\.[A-Za-z0-9_-]{20,}/,
  /\b1\/\/0[A-Za-z0-9_-]{30,}/, /\bAQ[A-Za-z0-9_-]{100,}/, /\bIGQ[A-Za-z0-9_-]{40,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\./, /\bhf_[A-Za-z0-9]{30,}/];
const PUBLIC_HOSTS = new Set(['api.linkedin.com', 'www.linkedin.com', 'learn.microsoft.com', 'graph.facebook.com', 'graph-video.facebook.com',
  'www.facebook.com', 'developers.facebook.com', 'business.facebook.com', 'graph.instagram.com', 'api.instagram.com', 'www.instagram.com',
  'www.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com', 'developers.google.com', 'support.google.com', 'console.cloud.google.com',
  'www.youtube.com', 'studio.youtube.com', 'api.x.com', 'x.com', 'docs.x.com', 'developer.x.com', 'console.x.com', 't.co', 'www.heygen.com',
  'api.heygen.com', 'upload.heygen.com', 'docs.heygen.com', 'app.heygen.com', 'developers.heygen.com', 'www.linkedin.com', 'developer.linkedin.com', 'www.postgresql.org','github.com', 'raw.githubusercontent.com', 'www.apache.org', 'apache.org', 'json-schema.org', 'opencode.ai',
  'antigravity.google', 'docs.litellm.ai', 'ghcr.io', 'hub.docker.com', 'docker.io', 'registry.npmjs.org', 'www.npmjs.com', 'nodejs.org',
  'openrouter.ai', 'docs.vllm.ai', 'huggingface.co', 'modelcontextprotocol.io', 'docs.anthropic.com', 'code.claude.com',
  'developers.openai.com', 'geminicli.com', 'pnpm.io', 'learn.microsoft.com', 'git-scm.com', 'spdx.org', 'host.docker.internal']);
const hostAllowed = (h) => {
  h = h.toLowerCase().replace(/^\[|\]$/g, '');
  if (PUBLIC_HOSTS.has(h) || h === 'localhost' || /(^|\.)example\.(com|org|net)$/.test(h) || /\.example$|\.test$|\.invalid$/.test(h)) return true;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return isDocIp(h);
  if (h === '::1') return true;
  // bare placeholder names used in docs, e.g. http://gateway:4000
  return ['host', 'node', 'gateway', 'upstream', 'internal', 'api', 'db', 'a', 'b', 'r', 'x', 'fb', 'standin'].includes(h);
};

function scanText(name, text, forb) {
  const problems = [];
  const lower = text.toLowerCase();
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const w of forb.words) if (new RegExp(`(?<![a-z0-9])${esc(w)}(?![a-z0-9])`).test(lower)) problems.push(`${name}: private name/path "${w}"`);
  for (const w of forb.subs || []) if (lower.includes(w)) problems.push(`${name}: private name "${w}"`);
  for (const m of text.matchAll(IPV4)) {
    const ip = m[0];
    if (forb.ips.includes(ip)) problems.push(`${name}: private address ${ip}`);
    else if (PRIVATE_IP.test(ip)) problems.push(`${name}: private-range address ${ip}`);
  }
  if (/\.ts\.net\b/i.test(text)) problems.push(`${name}: tailnet name`);
  for (const m of text.matchAll(UUID_RE)) {
    if ((forb.uuids ?? []).includes(m[0].toLowerCase())) problems.push(`${name}: private id ${m[0]}`);
    else if (!SYNTHETIC_UUID.test(m[0])) problems.push(`${name}: non-synthetic uuid ${m[0]} (use 00000000-0000-4000-8000-…)`);
  }
  for (const re of SECRET_SHAPES) if (re.test(text)) problems.push(`${name}: token-shaped string ${re}`);
  for (const m of text.matchAll(URL_HOST)) if (!hostAllowed(m[1]) && !m[1].includes('$')) problems.push(`${name}: URL host not allowed: ${m[1]}`);
  return problems;
}

const FORB = deriveForbidden();

test('leak scan: private sources were read', () => {
  assert.ok(FORB.words.length > 0, 'at least this machine\'s user and host names');
  if (process.env.POSTGATE_LEAK_STRICT === '1') assert.ok(FORB.sources.length > 0, 'POSTGATE_LEAK_STRICT=1 needs POSTGATE_LEAK_SOURCES');
});

test('leak scan: working tree', () => {
  const problems = [];
  for (const f of repoFiles()) problems.push(...scanText(relative(ROOT, f), readFileSync(f, 'utf8'), FORB));
  // the file names themselves too
  problems.push(...scanText('(paths)', repoFiles().map((f) => relative(ROOT, f)).join('\n'), FORB));
  assert.deepEqual([...new Set(problems)], []);
});

test('leak scan: git history (POSTGATE_LEAK_HISTORY=1)', { skip: process.env.POSTGATE_LEAK_HISTORY !== '1' }, () => {
  const r = spawnSync('git', ['-C', ROOT, 'log', '--all', '-p', '--no-color', '--format=commit %H%n%B'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) return;
  // removed lines are not in any tree; commit trailers (Co-Authored-By, Claude-Session) are
  // attribution required by the project and are reviewed when the history is squashed for release
  const added = r.stdout.split('\n').filter((l) => !l.startsWith('-') && !/^\s*(Co-Authored-By|Claude-Session):/.test(l)).join('\n');
  assert.deepEqual([...new Set(scanText('(history)', added, FORB))], []);
});

test('leak scan rules catch what they should (self-test with synthetic input)', () => {
  const synthetic = { words: ['acme-private-node'], subs: ['zorblat'], ips: ['198.18.7.7'], uuids: [] };
  const hit = (t) => scanText('x', t, synthetic).length > 0;
  assert.ok(hit('ssh acme-private-node'));
  assert.ok(!hit('ssh acme-private-nodes-are-other'));
  assert.ok(hit('brand Zorblatcorp'));
  assert.ok(hit('addr 198.18.7.7'));
  assert.ok(hit(`addr ${[10, 1, 2, 3].join('.')}`));
  assert.ok(hit(`host box${'.ts'}.net`));
  assert.ok(hit(`key ${'sk-'}${'a'.repeat(24)}`));
  assert.ok(hit(`key ${'pgate_'}${'Ab3dE5gH9kLmN0pQ2rStU4vWx6yZ8aBcD1eF7gHiJ'}`));
  assert.ok(!hit(`key ${'pgate_'}${'k'.repeat(43)}`), 'repeated-char test keys are fine');
  assert.ok(hit(`token ${'EAA'}${'Bx9'.repeat(16)}`));
  assert.ok(hit(`tenant ${'3f2b8c1e'}-9a4d-4e2f-8b7c-1d2e3f4a5b6c`));
  assert.ok(!hit(`tenant 00000000-0000-4000-8000-00000000000a`));
  assert.ok(hit(`url https://${'intranet'}.corp.internal/x`));
  assert.ok(!hit('url https://mcp.example.com/mcp and http://127.0.0.1:4000 and 192.0.2.10'));
});
