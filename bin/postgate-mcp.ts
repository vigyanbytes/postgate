#!/usr/bin/env node
// stdio MCP server. Env: POSTGATE_URL, POSTGATE_KEY (an automation key). Logs go to stderr; stdout is the protocol.
import { createInterface } from 'node:readline';
import { apiClient } from '../src/client/api.ts';
import { assertAgentKey, createMcpHandler } from '../src/mcp/server.ts';

const request = apiClient({ baseUrl: process.env.POSTGATE_URL, key: process.env.POSTGATE_KEY });
try {
  await assertAgentKey(request);
} catch (e) {
  console.error(`[postgate-mcp] ${(e as Error).message}`);
  process.exit(1);
}
const handle = createMcpHandler(request);
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg: unknown;
  try { msg = JSON.parse(line); } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
    return;
  }
  const out = await handle(msg);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
});
