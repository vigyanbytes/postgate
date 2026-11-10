// docs/API.md is the contract clients are built against: every route must be documented there.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { API_ROUTES } from '../src/api/server.ts';

const doc = readFileSync(new URL('../docs/API.md', import.meta.url), 'utf8');

describe('docs/API.md', () => {
  for (const [method, path] of API_ROUTES) {
    it(`documents ${method} ${path}`, () => assert.ok(doc.includes(`\`${method} ${path}\``), `${method} ${path} missing from docs/API.md`));
  }
});
