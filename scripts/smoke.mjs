#!/usr/bin/env node
// Live check against the real CLIs: starts the MCP server, sends one consultation,
// and prints the result. Spends real model quota.
//
//   node scripts/smoke.mjs codex  [project-dir] [request]
//   node scripts/smoke.mjs claude [project-dir] [request]
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const [peer = 'codex', cwd = process.cwd(), request = 'Smoke test: list the top-level files of this directory and summarize in one sentence what the project is. Cite the files you looked at.'] = process.argv.slice(2);
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'crosscheck.mjs');

const child = spawn(process.execPath, [server, '--peer', peer], {
  cwd,
  env: { ...process.env, CROSSCHECK_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const started = Date.now();

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'notifications/progress') {
    console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${message.params.message}`);
  } else if (message.id === 1) {
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: `ask_${peer}`, arguments: { request, cwd: path.resolve(cwd) }, _meta: { progressToken: 'smoke' },
    } });
  } else if (message.id === 2) {
    console.log(`\n----- result (isError=${message.result?.isError}) -----\n${message.result?.content?.[0]?.text ?? JSON.stringify(message)}`);
    child.stdin.end();
  }
});

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' },
} });
