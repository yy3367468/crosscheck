// End-to-end tests of the MCP server against a fake peer CLI (test/fixtures/fake-peer.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanCommand } from '../server/peers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server', 'crosscheck.mjs');
const FAKE_PEER = path.join(ROOT, 'test', 'fixtures', 'fake-peer.mjs');
const TIMEOUT = { timeout: 30_000 };

class Client {
  constructor(peer, { env = {}, cwd } = {}) {
    const baseEnv = { ...process.env };
    for (const key of Object.keys(baseEnv)) {
      if (key.startsWith('CROSSCHECK_') || key.startsWith('FAKE_PEER_') || key === 'CLAUDE_PROJECT_DIR') delete baseEnv[key];
    }
    this.child = spawn(process.execPath, [SERVER, '--peer', peer], {
      cwd,
      env: {
        ...baseEnv,
        CROSSCHECK_CODEX_BIN: FAKE_PEER,
        CROSSCHECK_CLAUDE_BIN: FAKE_PEER,
        CLAUDECODE: '1',
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
        CLAUDE_CODE_SESSION_ID: 'host-session',
        FAKE_KEEP: 'kept',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      const resolve = this.pending.get(message.id);
      if (resolve && !message.method) {
        this.pending.delete(message.id);
        resolve(message);
      } else {
        this.notifications.push(message);
      }
    });
    this.child.stderr.setEncoding('utf8').on('data', (chunk) => { this.stderr += chunk; });
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    const response = new Promise((resolve) => this.pending.set(id, resolve));
    this.send({ jsonrpc: '2.0', id, method, params });
    return { id, response };
  }

  call(method, params) {
    return this.request(method, params).response;
  }

  async init() {
    const response = await this.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return response;
  }

  async ask(tool, args, meta) {
    const response = await this.call('tools/call', { name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) });
    assert.ok(response.result, `expected a result, got ${JSON.stringify(response)}`);
    return { ...response.result, text: response.result.content[0].text };
  }

  async close() {
    this.child.stdin.end();
    if (this.child.exitCode === null) await once(this.child, 'exit');
  }
}

async function withClient(peer, options, fn) {
  const client = new Client(peer, options);
  try {
    await client.init();
    return await fn(client);
  } finally {
    await client.close();
  }
}

function peerEcho(text) {
  const match = text.match(/===== BEGIN \w+ REPLY =====\n([\s\S]*?)\n===== END \w+ REPLY =====/);
  assert.ok(match, `no reply block in:\n${text}`);
  return JSON.parse(match[1]);
}

function hasPair(argv, a, b) {
  return argv.some((value, i) => value === a && argv[i + 1] === b);
}

function realDir(dir) {
  return fs.realpathSync.native(dir).toLowerCase();
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-test-'));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test('initialize negotiates the protocol and advertises tools', TIMEOUT, async () => {
  const client = new Client('codex');
  try {
    const { result } = await client.init();
    assert.equal(result.protocolVersion, '2025-06-18');
    assert.equal(result.serverInfo.name, 'crosscheck');
    assert.ok(result.capabilities.tools);
    assert.ok(result.capabilities.experimental['codex/sandbox-state-meta']);
    assert.match(result.instructions, /skeptical/);

    const fallback = await client.call('initialize', { protocolVersion: '1999-01-01' });
    assert.equal(fallback.result.protocolVersion, '2025-11-25');
  } finally {
    await client.close();
  }
});

test('tools/list exposes ask_codex or ask_claude depending on --peer', TIMEOUT, async () => {
  await withClient('codex', {}, async (client) => {
    const { result } = await client.call('tools/list', {});
    assert.deepEqual(result.tools.map((t) => t.name), ['ask_codex']);
    const [tool] = result.tools;
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.deepEqual(tool.inputSchema.required, ['request']);
    assert.match(tool.description, /untrusted/);
  });
  await withClient('claude', {}, async (client) => {
    const { result } = await client.call('tools/list', {});
    assert.deepEqual(result.tools.map((t) => t.name), ['ask_claude']);
  });
});

test('ask_codex runs codex read-only and returns the reply as untrusted', TIMEOUT, async () => {
  const project = tempDir();
  await withClient('codex', {}, async (client) => {
    const result = await client.ask('ask_codex', { request: '请检查这个方案：用 Redis 做分布式锁', cwd: project });
    assert.equal(result.isError, false);
    assert.match(result.text, /^Codex replied after \d+s\. This is an unverified second opinion/);
    assert.match(result.text, /session_id: fake-thread-1 \(.*2 follow-ups left\)/);
    assert.match(result.text, /usage 1200 in \/ 80 out tokens/);
    assert.match(result.text, /- \$ git log --oneline -3\n/);
    assert.match(result.text, /- \$ rg -n TODO src → exit 1/);

    const echo = peerEcho(result.text);
    assert.equal(echo.argv[0], 'exec');
    assert.ok(!echo.argv.includes('resume'));
    assert.ok(hasPair(echo.argv, '-c', 'sandbox_mode=read-only'));
    assert.ok(hasPair(echo.argv, '-c', 'approval_policy=never'));
    assert.ok(hasPair(echo.argv, '-c', 'features.plugins=false'));
    assert.ok(hasPair(echo.argv, '-c', 'notify=[]'));
    assert.ok(hasPair(echo.argv, '--thread-source', 'crosscheck'));
    assert.ok(hasPair(echo.argv, '-c', 'mcp_servers.lanhu.enabled=false'));
    assert.ok(hasPair(echo.argv, '-c', 'mcp_servers.node_repl.enabled=false'));
    assert.ok(hasPair(echo.argv, '-c', 'mcp_servers.scope:tool@v1/x.enabled=false'));
    assert.ok(!echo.argv.some((a) => a.includes('off_server') || a.includes('off.dotted')));
    assert.equal(echo.argv.at(-1), '-');

    assert.equal(realDir(echo.cwd), realDir(project));
    assert.match(echo.prompt, /independent peer reviewer/);
    assert.match(echo.prompt, /Task type: REVIEW/);
    assert.match(echo.prompt, /请检查这个方案：用 Redis 做分布式锁/);

    assert.equal(echo.depth, '1');
    assert.equal(echo.env.CLAUDECODE, null);
    assert.equal(echo.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, null);
    assert.equal(echo.env.CLAUDE_CODE_SESSION_ID, null);
    assert.equal(echo.env.FAKE_KEEP, 'kept');
  });
});

test('independent mode sends the unanchored instructions', TIMEOUT, async () => {
  await withClient('codex', {}, async (client) => {
    const result = await client.ask('ask_codex', { request: 'Why does the cache miss?', mode: 'independent' });
    const echo = peerEcho(result.text);
    assert.match(echo.prompt, /Task type: INDEPENDENT ANALYSIS/);
    assert.doesNotMatch(echo.prompt, /Task type: REVIEW/);
  });
});

test('follow-ups resume the same session until the limit', TIMEOUT, async () => {
  await withClient('codex', { env: { CROSSCHECK_MAX_FOLLOWUPS: '1' } }, async (client) => {
    const first = await client.ask('ask_codex', { request: 'Review the plan.' });
    assert.match(first.text, /session_id: fake-thread-1 \(.*1 follow-up left\)/);

    const second = await client.ask('ask_codex', { request: 'I dispute finding 2: see src/a.js:10.', session_id: 'fake-thread-1', mode: 'independent' });
    assert.equal(second.isError, false);
    assert.match(second.text, /no follow-ups left/);
    const echo = peerEcho(second.text);
    assert.deepEqual(echo.argv.slice(0, 3), ['exec', 'resume', 'fake-thread-1']);
    assert.ok(hasPair(echo.argv, '-c', 'sandbox_mode=read-only'));
    assert.match(echo.prompt, /FOLLOW-UP FROM THE REQUESTER/);
    assert.match(echo.prompt, /I dispute finding 2/);
    assert.match(echo.prompt, /Position: CHANGED \| PARTIALLY CHANGED \| UNCHANGED/);
    assert.doesNotMatch(echo.prompt, /Task type:/);

    const third = await client.ask('ask_codex', { request: 'One more round?', session_id: 'fake-thread-1' });
    assert.equal(third.isError, true);
    assert.match(third.text, /Follow-up limit reached \(1\)/);
  });
});

test('unknown session ids are rejected', TIMEOUT, async () => {
  await withClient('codex', {}, async (client) => {
    const result = await client.ask('ask_codex', { request: 'continue', session_id: 'not-a-session' });
    assert.equal(result.isError, true);
    assert.match(result.text, /Unknown session_id/);
  });
});

test('invalid input is reported as a tool error', TIMEOUT, async () => {
  await withClient('codex', {}, async (client) => {
    assert.match((await client.ask('ask_codex', {})).text, /"request" is required/);
    assert.match((await client.ask('ask_codex', { request: 'x', mode: 'vote' })).text, /"mode" must be one of/);
    const missing = await client.ask('ask_codex', { request: 'x', cwd: path.join(os.tmpdir(), 'crosscheck-missing-dir-xyz') });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Working directory not found/);
  });
});

test('protocol errors use JSON-RPC error codes', TIMEOUT, async () => {
  await withClient('codex', {}, async (client) => {
    assert.equal((await client.call('tools/call', { name: 'ask_claude', arguments: {} })).error.code, -32602);
    assert.equal((await client.call('resources/list', {})).error.code, -32601);
    assert.deepEqual(await client.call('ping', {}), { jsonrpc: '2.0', id: 4, result: {} });

    const before = client.notifications.length;
    client.child.stdin.write('{not json\n');
    assert.ok(await waitFor(() => client.notifications.length > before));
    assert.equal(client.notifications.at(-1).error.code, -32700);
  });
});

test('the project directory comes from Codex sandbox metadata', TIMEOUT, async () => {
  const project = tempDir();
  fs.mkdirSync(path.join(project, 'sub'));
  const elsewhere = tempDir();
  await withClient('claude', { cwd: elsewhere }, async (client) => {
    const meta = { 'codex/sandbox-state-meta': { sandboxCwd: pathToFileURL(project).href } };
    const result = await client.ask('ask_claude', { request: 'Review.' }, meta);
    assert.equal(realDir(peerEcho(result.text).cwd), realDir(project));

    const nested = await client.ask('ask_claude', { request: 'Review.', cwd: 'sub' }, meta);
    assert.equal(realDir(peerEcho(nested.text).cwd), realDir(path.join(project, 'sub')));
  });
});

test('the project directory falls back to CLAUDE_PROJECT_DIR', TIMEOUT, async () => {
  const project = tempDir();
  await withClient('codex', { cwd: tempDir(), env: { CLAUDE_PROJECT_DIR: project } }, async (client) => {
    const result = await client.ask('ask_codex', { request: 'Review.' });
    assert.equal(realDir(peerEcho(result.text).cwd), realDir(project));
  });
});

test('recursion: no tools inside a consultation, and Codex children are refused', TIMEOUT, async () => {
  await withClient('codex', { env: { CROSSCHECK_DEPTH: '1' } }, async (client) => {
    assert.deepEqual((await client.call('tools/list', {})).result.tools, []);
    const result = await client.ask('ask_codex', { request: 'Review.' });
    assert.equal(result.isError, true);
    assert.match(result.text, /recursion guard/);
  });
  await withClient('claude', {}, async (client) => {
    const meta = { 'x-codex-turn-metadata': { thread_source: 'crosscheck' } };
    const result = await client.ask('ask_claude', { request: 'Review.' }, meta);
    assert.equal(result.isError, true);
    assert.match(result.text, /recursion guard/);
  });
});

test('progress notifications relay the peer activity', TIMEOUT, async () => {
  await withClient('codex', {}, async (client) => {
    await client.ask('ask_codex', { request: 'Review.' }, { progressToken: 'tok-1' });
    const progress = client.notifications.filter((n) => n.method === 'notifications/progress');
    assert.ok(progress.length >= 2);
    assert.ok(progress.every((n) => n.params.progressToken === 'tok-1'));
    assert.ok(progress.some((n) => n.params.message === 'Codex: $ git log --oneline -3'));
    const values = progress.map((n) => n.params.progress);
    assert.deepEqual(values, [...values].sort((a, b) => a - b));
  });
});

test('cancellation kills the peer and sends no response', TIMEOUT, async () => {
  await withClient('codex', { env: { FAKE_PEER_SCENARIO: 'slow' } }, async (client) => {
    const { id, response } = client.request('tools/call', {
      name: 'ask_codex', arguments: { request: 'Review.' }, _meta: { progressToken: 7 },
    });
    let pid = null;
    assert.ok(await waitFor(() => {
      const note = client.notifications.find((n) => /pid=\d+/.test(n.params?.message ?? ''));
      pid = note ? Number(note.params.message.match(/pid=(\d+)/)[1]) : null;
      return pid !== null;
    }));
    assert.ok(isAlive(pid));
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'test' } });
    assert.ok(await waitFor(() => !isAlive(pid)), 'peer process should be killed');
    const raced = await Promise.race([response, new Promise((resolve) => setTimeout(() => resolve('none'), 500))]);
    assert.equal(raced, 'none');
  });
});

test('a peer that exceeds the timeout is killed and reported', TIMEOUT, async () => {
  await withClient('codex', { env: { FAKE_PEER_SCENARIO: 'slow', CROSSCHECK_TIMEOUT_SEC: '3' } }, async (client) => {
    const result = await client.ask('ask_codex', { request: 'Review.' });
    assert.equal(result.isError, true);
    assert.match(result.text, /Codex consultation failed after \d+s\. Codex did not finish before the timeout/);
    const pid = Number(result.text.match(/pid=(\d+)/)[1]);
    assert.ok(await waitFor(() => !isAlive(pid)));
  });
});

test('codex failures are surfaced, not mistaken for reviews', TIMEOUT, async () => {
  await withClient('codex', { env: { FAKE_PEER_SCENARIO: 'fail' } }, async (client) => {
    const result = await client.ask('ask_codex', { request: 'Review.' });
    assert.equal(result.isError, true);
    assert.match(result.text, /Codex failed: stream disconnected before completion/);
    assert.doesNotMatch(result.text, /session_id:/);
  });
  await withClient('codex', { env: { FAKE_PEER_SCENARIO: 'noreply' } }, async (client) => {
    const result = await client.ask('ask_codex', { request: 'Review.' });
    assert.equal(result.isError, true);
    assert.match(result.text, /Codex failed: it produced no reply/);
  });
});

test('a codex that could not run any command is flagged as ungrounded', TIMEOUT, async () => {
  await withClient('codex', { env: { FAKE_PEER_SCENARIO: 'startfail' } }, async (client) => {
    const result = await client.ask('ask_codex', { request: 'Review.' });
    assert.equal(result.isError, false);
    assert.match(result.text, /Codex could not run any command \(Failed to create unified exec process/);
    assert.match(result.text, /NOT grounded in the repository/);
    assert.match(result.text, /- \$ git status → failed to start/);
  });
});

test('MCP isolation fails closed', TIMEOUT, async () => {
  await withClient('codex', { env: { FAKE_PEER_SCENARIO: 'mcplistfail' } }, async (client) => {
    const result = await client.ask('ask_codex', { request: 'Review.' });
    assert.equal(result.isError, true);
    assert.match(result.text, /Could not list your Codex MCP servers/);
  });
  await withClient('codex', { env: { FAKE_PEER_SCENARIO: 'mcpbadname' } }, async (client) => {
    const result = await client.ask('ask_codex', { request: 'Review.' });
    assert.equal(result.isError, true);
    assert.match(result.text, /Your Codex MCP server "my\.server" cannot be disabled/);
    assert.doesNotMatch(result.text, /BEGIN CODEX REPLY/);
  });
});

test('descendants that outlive the peer do not hang the call and are killed', TIMEOUT, async () => {
  await withClient('codex', { env: { FAKE_PEER_SCENARIO: 'straggler' } }, async (client) => {
    const started = Date.now();
    const result = await client.ask('ask_codex', { request: 'Review.' });
    assert.equal(result.isError, false);
    assert.match(result.text, /done, but a child lingers/);
    assert.ok(Date.now() - started < 15_000, 'the call should finish soon after the peer exits');
    const straggler = Number(result.text.match(/straggler=(\d+)/)[1]);
    // POSIX: the leftover process group is SIGKILLed even though it ignores SIGTERM.
    // Windows: taskkill can no longer walk the tree from the exited peer (documented limitation).
    if (process.platform !== 'win32') assert.ok(isAlive(straggler) === false || await waitFor(() => !isAlive(straggler), 2000));
    else try { process.kill(straggler); } catch {}
  });
});

test('older codex without --thread-source still works', TIMEOUT, async () => {
  await withClient('codex', { env: { FAKE_PEER_SCENARIO: 'oldcodex' } }, async (client) => {
    const result = await client.ask('ask_codex', { request: 'Review.' });
    assert.equal(result.isError, false);
    assert.ok(!peerEcho(result.text).argv.includes('--thread-source'));
  });
});

test('extra codex arguments are allowlisted and come before the read-only settings', TIMEOUT, async () => {
  const good = '-m gpt-test -c model_reasoning_effort=high --config=windows.sandbox=unelevated';
  await withClient('codex', { env: { CROSSCHECK_CODEX_ARGS: good } }, async (client) => {
    const argv = peerEcho((await client.ask('ask_codex', { request: 'Review.' })).text).argv;
    assert.ok(hasPair(argv, '-m', 'gpt-test'));
    assert.ok(hasPair(argv, '--config', 'windows.sandbox=unelevated'));
    assert.ok(argv.indexOf('model_reasoning_effort=high') < argv.indexOf('sandbox_mode=read-only'));
  });
  const bad = ['--dangerously-bypass-approvals-and-sandbox', '-s danger-full-access', '-c sandbox_mode=danger-full-access',
    '--enable plugins', '--worktree', '-o out.txt', '-c mcp_servers.x.command=y', '-m'];
  for (const value of bad) {
    await withClient('codex', { env: { CROSSCHECK_CODEX_ARGS: value } }, async (client) => {
      const result = await client.ask('ask_codex', { request: 'Review.' });
      assert.equal(result.isError, true, value);
      assert.match(result.text, /CROSSCHECK_CODEX_ARGS: .* is not allowed\. Supported:/);
    });
  }
});

test('ask_claude runs claude in plan mode without MCP servers', TIMEOUT, async () => {
  const project = tempDir();
  await withClient('claude', {}, async (client) => {
    const result = await client.ask('ask_claude', { request: 'Review the migration plan.', cwd: project });
    assert.equal(result.isError, false);
    assert.match(result.text, /^Claude replied after/);
    assert.match(result.text, /model claude-fake-1 · usage \$0\.0123 \(session total\)/);
    assert.match(result.text, /- Read src\/app\.js:10\n/);
    assert.match(result.text, /- Grep "TODO" in src \(\*\.js\)/);
    assert.match(result.text, /- Read \.\.foo\/b\.js\n/);
    assert.match(result.text, /- Read \S+[\\/]\.\.[\\/]outside\.js\n/);
    assert.match(result.text, /- \$ git diff HEAD/);

    const echo = peerEcho(result.text);
    assert.equal(echo.argv[0], '-p');
    assert.ok(hasPair(echo.argv, '--output-format', 'stream-json'));
    assert.ok(hasPair(echo.argv, '--permission-mode', 'plan'));
    assert.ok(hasPair(echo.argv, '--tools', 'Read,Grep,Glob,Bash,PowerShell'));
    assert.ok(echo.argv.includes('--strict-mcp-config'));
    assert.ok(echo.argv.includes('--disable-slash-commands'));
    assert.ok(hasPair(echo.argv, '--setting-sources', 'user'));
    assert.ok(!echo.argv.includes('--resume'));
    assert.equal(realDir(echo.cwd), realDir(project));
    assert.equal(echo.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, null);

    const followup = await client.ask('ask_claude', { request: 'Recheck finding 1.', session_id: 'fake-session-1' });
    assert.ok(hasPair(peerEcho(followup.text).argv, '--resume', 'fake-session-1'));
  });
});

test('extra claude arguments are allowlisted', TIMEOUT, async () => {
  await withClient('claude', { env: { CROSSCHECK_CLAUDE_ARGS: '--model sonnet --effort=high' } }, async (client) => {
    const argv = peerEcho((await client.ask('ask_claude', { request: 'Review.' })).text).argv;
    assert.ok(hasPair(argv, '--model', 'sonnet'));
    assert.ok(hasPair(argv, '--effort', 'high'));
    assert.ok(argv.indexOf('--effort') < argv.indexOf('--permission-mode'));
  });
  const bad = ['--permission-mode bypassPermissions', '--dangerously-skip-permissions', '--setting-sources user,project',
    '--mcp-config x.json', '--worktree review', '--debug-file review.log', '--model --worktree'];
  for (const value of bad) {
    await withClient('claude', { env: { CROSSCHECK_CLAUDE_ARGS: value } }, async (client) => {
      const result = await client.ask('ask_claude', { request: 'Review.' });
      assert.equal(result.isError, true, value);
      assert.match(result.text, /CROSSCHECK_CLAUDE_ARGS: .* is not allowed/);
    });
  }
});

test('claude permission denials and failures are surfaced', TIMEOUT, async () => {
  await withClient('claude', { env: { FAKE_PEER_SCENARIO: 'denied' } }, async (client) => {
    const result = await client.ask('ask_claude', { request: 'Review.' });
    assert.match(result.text, /Claude was blocked from running Bash: npm install left-pad/);
  });
  await withClient('claude', { env: { FAKE_PEER_SCENARIO: 'fail' } }, async (client) => {
    const result = await client.ask('ask_claude', { request: 'Review.' });
    assert.equal(result.isError, true);
    assert.match(result.text, /Claude failed: Not logged in/);
  });
});

test('windows: .cmd shims are launched through cmd.exe with arguments intact', { ...TIMEOUT, skip: process.platform !== 'win32' }, async () => {
  const dir = tempDir();
  const shim = path.join(dir, 'fake-codex.cmd');
  fs.writeFileSync(shim, `@"${process.execPath}" "${FAKE_PEER}" %*\r\n`);
  await withClient('codex', { env: { CROSSCHECK_CODEX_BIN: shim, CROSSCHECK_CODEX_ARGS: '-c windows.sandbox=unelevated' } }, async (client) => {
    const result = await client.ask('ask_codex', { request: '中文 "quotes" & | < > % ^ ! 也要原样送达' });
    assert.equal(result.isError, false, result.text);
    const echo = peerEcho(result.text);
    assert.ok(hasPair(echo.argv, '-c', 'windows.sandbox=unelevated'));
    assert.ok(hasPair(echo.argv, '-c', 'notify=[]'));
    assert.ok(hasPair(echo.argv, '-c', 'mcp_servers.scope:tool@v1/x.enabled=false'));
    assert.equal(echo.argv.at(-1), '-');
    assert.match(echo.prompt, /中文 "quotes" & \| < > % \^ ! 也要原样送达/);
  });
});

test('a missing peer CLI gives an actionable error', TIMEOUT, async () => {
  await withClient('codex', { env: { CROSSCHECK_CODEX_BIN: path.join(os.tmpdir(), 'no-such-codex.exe') } }, async (client) => {
    const result = await client.ask('ask_codex', { request: 'Review.' });
    assert.equal(result.isError, true);
    assert.match(result.text, /was not found on PATH/);
  });
});

test('shell wrappers and their quoting are removed from reported commands', () => {
  assert.equal(cleanCommand("/bin/bash -lc 'rg -n TODO src'"), 'rg -n TODO src');
  assert.equal(cleanCommand(`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'git status'`), 'git status');
  assert.equal(cleanCommand(`"C:\pwsh.exe" -Command '$n = 0; gc a | % { '"'"'{0}'"'"' -f $n }'`), "$n = 0; gc a | % { '{0}' -f $n }");
  assert.equal(cleanCommand('/bin/zsh -lc "echo \\"hi\\" && ls"'), 'echo "hi" && ls');
  assert.equal(cleanCommand('git status'), 'git status');
});
