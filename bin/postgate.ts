#!/usr/bin/env node
import { readBytesFromDisk, run } from '../src/cli/cli.ts';

process.exitCode = await run(process.argv.slice(2), {
  env: process.env, fetch, out: (s) => console.log(s), err: (s) => console.error(s), readBytes: readBytesFromDisk,
  untilStopped: () => new Promise<void>((r) => { process.once('SIGINT', r); process.once('SIGTERM', r); }),
});
