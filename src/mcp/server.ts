// MCP server (stdio, JSON-RPC 2.0, newline-delimited; no SDK dependency). Lets any agent (Claude Code, Codex,
// Gemini CLI, OpenCode, …) list channels and posts, upload media, create drafts, ask for approval and set times.
// It has NO tool to approve, publish or cancel, and it refuses to start with a key that can approve: give the agent
// an automation key (`postgate key create my-agent`). A human approves every post; the database enforces it.
// Env: POSTGATE_URL, POSTGATE_KEY.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { mimeOfPath, type Request } from '../client/api.ts';

export const PROTOCOL_VERSION = '2025-06-18';
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

type Schema = { type: 'object'; properties: Record<string, any>; required?: string[]; additionalProperties?: boolean };
interface Tool { name: string; description: string; inputSchema: Schema; annotations: Record<string, boolean>; run(args: any): Promise<unknown> }

const RO = { readOnlyHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const target = { type: 'object', additionalProperties: false, properties: {
  provider: { type: 'string', description: 'linkedin | linkedin_page | facebook_page | instagram | youtube | x (when the tenant has one such channel)' },
  channelId: { type: 'string', pattern: UUID }, bodyOverride: { type: 'string', maxLength: 63000, description: 'per-channel variant of the text' },
  settings: { type: 'object', description: 'per-channel settings, e.g. {"firstComment": "…"}, {"privacyStatus": "private"}, {"thread": ["…"]}' } } };

export function tools(request: Request, readBytes: (p: string) => Promise<Uint8Array> = async (p) => new Uint8Array(await readFile(p))): Tool[] {
  return [
    { name: 'channels_list', description: 'Connected channels (provider, account, status) and each provider\'s limits.', annotations: RO,
      inputSchema: { type: 'object', properties: {} }, run: () => request('GET', '/v1/channels') },
    { name: 'posts_list', description: 'Posts, newest first. status: comma list of draft,in_review,approved,scheduled,publishing,published,partially_failed,failed,cancelled.',
      annotations: RO, inputSchema: { type: 'object', properties: { status: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 500 } } },
      run: (a) => request('GET', '/v1/posts', { query: { status: a.status, limit: a.limit } }) },
    { name: 'post_get', description: 'One post with its targets, approval state and history.', annotations: RO,
      inputSchema: { type: 'object', properties: { postId: { type: 'string', pattern: UUID } }, required: ['postId'] },
      run: (a) => request('GET', `/v1/posts/${a.postId}`) },
    { name: 'media_upload', description: 'Upload a local image/video/document file; returns a media id to put in draft_create.mediaIds.', annotations: RW,
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, altText: { type: 'string', maxLength: 1000 }, title: { type: 'string', maxLength: 300 } }, required: ['path'] },
      run: async (a) => {
        const mime = mimeOfPath(a.path);
        if (!mime) throw new Error(`unsupported file type: ${basename(a.path)}`);
        return request('POST', '/v1/media', { query: { altText: a.altText, title: a.title }, raw: { bytes: await readBytes(a.path), contentType: mime } });
      } },
    { name: 'draft_create', description: 'Create a DRAFT (never published by this tool). One body, optional per-channel variants and settings, optional proposed time (takes effect only after a human approves). Use sourceRef so a retry never makes a second draft.',
      annotations: RW, inputSchema: { type: 'object', required: ['body', 'targets'], properties: {
        body: { type: 'string', maxLength: 63000 }, title: { type: 'string', maxLength: 300 }, linkUrl: { type: 'string', maxLength: 2000 },
        mediaIds: { type: 'array', items: { type: 'string', pattern: UUID }, maxItems: 20 }, sourceRef: { type: 'string', maxLength: 300 },
        scheduledAt: { type: 'string', description: 'ISO 8601 with offset, or local wall-clock in timezone' }, timezone: { type: 'string' },
        targets: { type: 'array', minItems: 1, maxItems: 20, items: target } } },
      run: (a) => request('POST', '/v1/drafts', { body: a }) },
    { name: 'post_validate', description: 'Validation issues per channel (empty = ready to ask for approval).', annotations: RO,
      inputSchema: { type: 'object', properties: { postId: { type: 'string', pattern: UUID } }, required: ['postId'] },
      run: (a) => request('POST', `/v1/posts/${a.postId}/validate`) },
    { name: 'approval_request', description: 'Ask a human to approve the draft\'s current content. Only a human approver can approve; this tool cannot. Editing the post afterwards voids the request.',
      annotations: RW, inputSchema: { type: 'object', properties: { postId: { type: 'string', pattern: UUID }, ttlHours: { type: 'integer', minimum: 1, maximum: 168 } }, required: ['postId'] },
      run: ({ postId, ...body }) => request('POST', `/v1/posts/${postId}/approval-requests`, { body }) },
    { name: 'schedule_set', description: 'Set the publish time. Before approval it is only a proposal; an approved post becomes scheduled. Moving the time never needs a new approval.',
      annotations: RW, inputSchema: { type: 'object', required: ['postId', 'at'], properties: { postId: { type: 'string', pattern: UUID }, at: { type: 'string' }, timezone: { type: 'string' } } },
      run: ({ postId, at, timezone }) => request('POST', `/v1/posts/${postId}/schedule`, { body: { at, ...(timezone ? { timezone } : {}) } }) },
    { name: 'avatar_video_create', description: 'Generate an AI avatar video (HeyGen) from a script and attach it to a DRAFT post. Costs provider credits; needs a key with media:generate. consent must name who agreed that the face and voice may be used, or say "stock avatar". The draft still needs a human approval.',
      annotations: { ...RW, openWorldHint: true }, inputSchema: { type: 'object', required: ['script', 'avatarId', 'consent'], properties: {
        script: { type: 'string', maxLength: 5000 }, avatarId: { type: 'string', maxLength: 200 }, voiceId: { type: 'string', maxLength: 200 },
        consent: { type: 'string', maxLength: 500 }, postId: { type: 'string', pattern: UUID }, title: { type: 'string', maxLength: 200 },
        aspectRatio: { type: 'string', maxLength: 5 }, resolution: { type: 'string', maxLength: 5 } } },
      run: (a) => request('POST', '/v1/media-jobs', { body: { capability: 'avatar_video', provider: 'heygen', ...a } }) },
    { name: 'media_job_get', description: 'Status of a media generation job (queued/running/done/failed) and the resulting media id.', annotations: RO,
      inputSchema: { type: 'object', properties: { jobId: { type: 'string', pattern: UUID } }, required: ['jobId'] },
      run: (a) => request('GET', `/v1/media-jobs/${a.jobId}`) },
    { name: 'schedule_clear', description: 'Remove the publish time (an approved post stays approved, unscheduled).', annotations: RW,
      inputSchema: { type: 'object', properties: { postId: { type: 'string', pattern: UUID } }, required: ['postId'] },
      run: (a) => request('POST', `/v1/posts/${a.postId}/unschedule`) },
  ];
}

function check(schema: Schema, args: any): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const r of schema.required ?? []) if (args[r] === undefined) return `${r} is required`;
  for (const [k, v] of Object.entries(args)) {
    const s = schema.properties[k];
    if (!s) return `unknown argument ${k}`;
    if (s.type === 'string' && (typeof v !== 'string' || (s.pattern && !new RegExp(s.pattern).test(v)) || (s.maxLength && v.length > s.maxLength))) return `${k} is not a valid ${s.pattern ? 'uuid' : 'string'}`;
    if (s.type === 'integer' && (!Number.isInteger(v) || (s.minimum !== undefined && (v as number) < s.minimum) || (s.maximum !== undefined && (v as number) > s.maximum))) return `${k} must be an integer in range`;
    if (s.type === 'array' && (!Array.isArray(v) || (s.minItems && v.length < s.minItems) || (s.maxItems && v.length > s.maxItems))) return `${k} must be a list`;
  }
  return null;
}

/** One JSON-RPC message in, zero or one out. */
export function createMcpHandler(request: Request, readBytes?: (p: string) => Promise<Uint8Array>) {
  const list = tools(request, readBytes);
  return async function handle(msg: any): Promise<object | null> {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
    const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'invalid request');
    const isNotification = msg.id === undefined;
    switch (msg.method) {
      case 'initialize':
        return reply({ protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'postgate', version: '0.1.0' },
          instructions: 'Drafts and approval requests only. A human approves every post before anything is published.' });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: list.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
      case 'tools/call': {
        const t = list.find((x) => x.name === msg.params?.name);
        if (!t) return error(-32602, `unknown tool ${msg.params?.name}`);
        const args = msg.params?.arguments ?? {};
        const bad = check(t.inputSchema, args);
        if (bad) return reply({ isError: true, content: [{ type: 'text', text: bad }] });
        try {
          return reply({ content: [{ type: 'text', text: JSON.stringify(await t.run(args), null, 2) }] });
        } catch (e) {
          return reply({ isError: true, content: [{ type: 'text', text: (e as Error).message }] });
        }
      }
      default:
        return isNotification ? null : error(-32601, `method not found: ${msg.method}`);
    }
  };
}

/** Refuse keys that can approve: an agent must never hold one. */
export async function assertAgentKey(request: Request): Promise<void> {
  const me = await request('GET', '/v1/me');
  if (me.canDecide || (me.scopes ?? []).includes('approvals:decide')) {
    throw new Error('this key can approve posts; an agent must not hold one. Create an automation key: postgate key create <agent-name>');
  }
}
