#!/usr/bin/env node
// Stand-in for the codex and claude CLIs in tests. Emits their event streams and
// answers with a JSON echo of what it received. Behaviour is selected with the
// FAKE_PEER_SCENARIO environment variable.
const argv = process.argv.slice(2);
const scenario = process.env.FAKE_PEER_SCENARIO || 'ok';
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function echo(prompt) {
  return JSON.stringify({
    argv,
    cwd: process.cwd(),
    depth: process.env.CROSSCHECK_DEPTH ?? null,
    prompt,
    env: {
      CLAUDECODE: process.env.CLAUDECODE ?? null,
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST ?? null,
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID ?? null,
      FAKE_KEEP: process.env.FAKE_KEEP ?? null,
    },
  });
}

const hang = () => setTimeout(() => {}, 120_000);

async function codex() {
  if (argv[0] === 'mcp' && argv[1] === 'list') {
    if (scenario === 'mcplistfail') {
      process.stderr.write('Error: failed to load configuration\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify([
      { name: 'lanhu', enabled: true },
      { name: 'off_server', enabled: false },
      { name: 'off.dotted', enabled: false },
      { name: 'scope:tool@v1/x', enabled: true },
      { name: 'node_repl', enabled: true },
      ...(scenario === 'mcpbadname' ? [{ name: 'my.server', enabled: true }] : []),
    ], null, 2));
    return;
  }
  if (argv.includes('--help')) {
    process.stdout.write(scenario === 'oldcodex'
      ? 'Usage: codex exec [OPTIONS] [PROMPT]\n'
      : 'Usage: codex exec [OPTIONS] [PROMPT]\n      --thread-source <SOURCE>\n');
    return;
  }
  const prompt = await readStdin();
  const threadId = argv[1] === 'resume' ? argv[2] : 'fake-thread-1';
  out({ type: 'thread.started', thread_id: threadId });
  out({ type: 'turn.started' });
  out({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' } });

  if (scenario === 'slow') {
    out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: `pid=${process.pid}`, aggregated_output: '', exit_code: 0, status: 'completed' } });
    return hang();
  }
  if (scenario === 'straggler') {
    // A descendant that ignores SIGTERM and keeps our stdout open after we exit.
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 120000)"], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.unref();
    out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: `straggler=${child.pid}`, aggregated_output: '', exit_code: 0, status: 'completed' } });
    out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'done, but a child lingers' } });
    out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  }
  if (scenario === 'fail') {
    out({ type: 'error', message: 'Reconnecting... 1/5' });
    out({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } });
    process.exitCode = 1;
    return;
  }
  if (scenario === 'startfail') {
    for (const [id, command] of [['item_1', 'git status'], ['item_2', 'rg TODO']]) {
      out({ type: 'item.completed', item: { id, type: 'command_execution', command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${command}'`, aggregated_output: 'Failed to create unified exec process: helper_unknown_error: setup refresh had errors', exit_code: -1, status: 'failed' } });
    }
    out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'I could not run commands, but the plan looks fine.' } });
    out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
    return;
  }
  if (scenario === 'noreply') {
    out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 0 } });
    return;
  }
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'git log --oneline -3'`, aggregated_output: 'abc init\n', exit_code: 0, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: "/bin/bash -lc 'rg -n TODO src'", aggregated_output: '', exit_code: 1, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Looking at the code now.' } });
  out({ type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: echo(prompt) } });
  out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 80 } });
}

async function claude() {
  const prompt = await readStdin();
  const resumeAt = argv.indexOf('--resume');
  const sessionId = resumeAt >= 0 ? argv[resumeAt + 1] : 'fake-session-1';
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fake-1', tools: ['Read', 'Grep', 'Glob', 'Bash'], permissionMode: 'plan' });

  if (scenario === 'slow') {
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't0', name: 'Bash', input: { command: `pid=${process.pid}` } }] } });
    return hang();
  }
  if (scenario === 'fail') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: sessionId, permission_denials: [] });
    process.exitCode = 1;
    return;
  }
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${process.cwd()}/src/app.js`, offset: 10 } },
    { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'TODO', path: `${process.cwd()}/src`, glob: '*.js' } },
  ] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '...' }] } });
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'git diff HEAD' } }] } });
  const denials = scenario === 'denied'
    ? [{ tool_name: 'Bash', tool_use_id: 't4', tool_input: { command: 'npm install left-pad' } }]
    : [];
  const reply = echo(prompt);
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sessionId, total_cost_usd: 0.0123, permission_denials: denials });
}

if (argv[0] === '-p') claude();
else codex();
