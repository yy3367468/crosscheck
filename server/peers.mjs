// Runs the peer CLIs (codex, claude) as read-only consultants and parses their event streams.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

// Every token we put on a peer command line must match this. On Windows the npm
// shims (codex.cmd, claude.cmd) run through cmd.exe, so characters cmd.exe would
// interpret (whitespace, quotes, parentheses, ^ & | < > % !) are refused.
const SAFE_TOKEN = /^[\w.,:=@+\/\[\]-]+$/;
// MCP server names that can be addressed as a bare TOML key in `-c mcp_servers.<name>...`.
const SERVER_KEY = /^[\w:@\/-]+$/;

// Variables describing the host agent's own session. A nested CLI that inherits them
// misbehaves (Claude Code, for example, reports "Not logged in" when it sees the
// desktop app's host-auth variables), so they are removed from the child environment.
const HOST_SESSION_VAR = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_AGENT_SDK_\w+|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|EXECPATH|PROVIDER_MANAGED_BY_HOST|DIAGNOSTICS_FILE|HOST_\w+|SDK_\w+|MESSAGING_\w+|DESKTOP_\w+|SESSION_\w+))$/;

const MAX_ACTIVITY_TEXT = 160;
const STDERR_TAIL = 4000;
const HELPER_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 3000;
const STRAGGLER_MS = 5000;

export class UserError extends Error {}
export class CancelledError extends Error {}

const active = new Set();

export function killAll() {
  for (const child of active) terminate(child, 'SIGKILL');
  active.clear();
}

// Returns how to launch a peer CLI, or null when it cannot be found. The override
// may be a path or a command name on PATH; a .js/.mjs/.cjs file runs with this Node.
export function resolveBinary(name, override) {
  if (override && /\.[cm]?js$/i.test(override)) return { command: process.execPath, prefix: [override], shell: false };
  let found;
  if (!override) found = findOnPath(name);
  else if (/[\\/]/.test(override)) found = isFile(override) ? override : null;
  else found = findOnPath(override);
  if (!found) return null;
  const shell = IS_WIN && /\.(cmd|bat)$/i.test(found);
  if (shell && /["%!^&|<>]/.test(found)) throw new UserError(`Unsupported characters in executable path: ${found}`);
  return { command: found, prefix: [], shell };
}

function findOnPath(name) {
  // On Windows a bare name also matches npm's extensionless sh shims, which
  // cannot be spawned, so only names that already carry an extension are tried as-is.
  const exts = IS_WIN ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const suffixes = IS_WIN && exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase())) ? [''] : exts;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name + suffix.toLowerCase());
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// Extra arguments from CROSSCHECK_*_ARGS may only choose the model and similar
// knobs. Anything else (worktrees, output files, sandbox or permission changes)
// is refused, so the read-only setup cannot be loosened by accident.
export function parseExtraArgs(value, envName, allowed) {
  const tokens = (value || '').trim().split(/\s+/).filter(Boolean);
  const args = [];
  const reject = (what) => new UserError(`${envName}: ${what} is not allowed. Supported: ${allowed.summary}.`);
  for (let i = 0; i < tokens.length; i++) {
    const eq = tokens[i].startsWith('--') ? tokens[i].indexOf('=') : -1;
    const flag = eq > 0 ? tokens[i].slice(0, eq) : tokens[i];
    const kind = allowed.flags[flag];
    if (!kind) throw reject(`option "${tokens[i]}"`);
    const val = eq > 0 ? tokens[i].slice(eq + 1) : tokens[++i];
    if (!val || val.startsWith('-') || !SAFE_TOKEN.test(val)) throw reject(`value "${val ?? ''}" for ${flag}`);
    if (kind === 'config' && !allowed.configKeys.test(val.split('=')[0])) throw reject(`config key "${val.split('=')[0]}"`);
    args.push(flag, val);
  }
  return args;
}

export function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!HOST_SESSION_VAR.test(key)) env[key] = value;
  }
  env.CROSSCHECK_DEPTH = String((Number(process.env.CROSSCHECK_DEPTH) || 0) + 1);
  return env;
}

// On POSIX the peer leads its own process group, which is signalled even after the
// leader has exited, so descendants are reached too. On Windows taskkill /T walks
// the tree from the peer, which only works while the peer is alive.
function terminate(child, signal) {
  if (!child.pid) return;
  if (IS_WIN) {
    if (child.exitCode === null && child.signalCode === null) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
    return;
  }
  try { process.kill(-child.pid, signal); } catch {}
}

export function runProcess({ bin, args, cwd, env, input, timeoutMs, signal, onLine }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const options = { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN };
    let child;
    try {
      if (bin.shell) {
        const bad = args.find((arg) => !SAFE_TOKEN.test(arg));
        if (bad) throw new UserError(`Refusing to pass an unsafe argument through cmd.exe: ${bad}`);
        child = spawn([`"${bin.command}"`, ...args].join(' '), { ...options, shell: true });
      } else {
        child = spawn(bin.command, args, options);
      }
    } catch (err) {
      return reject(err);
    }
    active.add(child);

    let buffer = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    const emit = (line) => { if (line.trim()) onLine(line.trim()); };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        emit(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });

    let forceTimer = null;
    let stragglerTimer = null;
    const stop = () => {
      terminate(child, 'SIGTERM');
      if (!IS_WIN) forceTimer ??= setTimeout(() => terminate(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => { cancelled = true; stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(stragglerTimer);
      signal?.removeEventListener('abort', onAbort);
      active.delete(child);
    };

    child.on('error', (err) => {
      cleanup();
      reject(new UserError(`Could not start ${bin.command}: ${err.message}`));
    });
    // Descendants that outlive the peer while holding its stdout/stderr would delay
    // 'close' indefinitely. Shortly after the peer exits they are killed and no
    // longer waited for. Processes that released the pipes (daemons) are left alone.
    child.on('exit', () => {
      stragglerTimer = setTimeout(() => {
        terminate(child, 'SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }, STRAGGLER_MS);
    });
    child.on('close', (code) => {
      // After a timeout or cancellation, finish killing the peer's process group now
      // instead of relying on the SIGKILL timer that cleanup() cancels.
      if (timedOut || cancelled) terminate(child, 'SIGKILL');
      cleanup();
      emit(buffer);
      if (cancelled) return reject(new CancelledError());
      resolve({ code, stderr: stderr.trim(), timedOut });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
  });
}

// Runs a short helper command and returns its stdout, or null if it failed.
async function capture(bin, args, cwd, { signal, timeoutMs = HELPER_TIMEOUT_MS } = {}) {
  let out = '';
  const { code, timedOut } = await runProcess({
    bin, args, cwd, env: childEnv(), input: '', timeoutMs: Math.min(timeoutMs, HELPER_TIMEOUT_MS), signal,
    onLine: (line) => { out += `${line}\n`; },
  });
  return code === 0 && !timedOut ? out : null;
}

function clip(text, max = MAX_ACTIVITY_TEXT) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function firstLine(text) {
  return clip(String(text ?? '').split(/\r?\n/).find((line) => line.trim()) ?? '');
}

function relativePath(cwd, file) {
  if (typeof file !== 'string') return '';
  // The peer may report symlink-resolved paths (macOS: /var -> /private/var).
  let real = cwd;
  try { real = fs.realpathSync.native(cwd); } catch {}
  for (const base of new Set([cwd, real])) {
    const rel = path.relative(base, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return file;
}

// Codex reports shell commands wrapped in the shell that ran them, e.g.
// `"C:\...\powershell.exe" -Command 'git status'` or `/bin/bash -lc 'git status'`.
export function cleanCommand(command) {
  let text = String(command ?? '').trim();
  const match = text.match(/^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+\s+)*?-Command\s+([\s\S]+)$/i)
    || text.match(/^\S*?\b(?:bash|zsh|sh)\s+-l?c\s+([\s\S]+)$/);
  if (match) text = match[1].trim();
  text = unquoteWord(text) ?? text;
  return clip(text);
}

// Undoes POSIX shell quoting when the text is a single word, e.g.
// 'a '"'"'b'"'"' c' -> a 'b' c. Returns null when it is not one quoted word.
function unquoteWord(text) {
  if (!/^['"]/.test(text)) return null;
  let out = '';
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      out += text.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && /["\\$`]/.test(text[j + 1] ?? '')) j++;
        out += text[j];
      }
      if (j >= text.length) return null;
      i = j + 1;
    } else if (ch === '\\' && i + 1 < text.length) {
      out += text[i + 1];
      i += 2;
    } else if (/\s/.test(ch)) {
      return null;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const codex = {
  key: 'codex',
  name: 'Codex',
  binName: 'codex',
  binEnv: 'CROSSCHECK_CODEX_BIN',
  argsEnv: 'CROSSCHECK_CODEX_ARGS',
  extraArgs: {
    flags: { '-m': 'value', '--model': 'value', '-c': 'config', '--config': 'config' },
    configKeys: /^(model|model_provider|model_reasoning_effort|model_reasoning_summary|model_verbosity|service_tier|windows\.sandbox|model_providers\.[\w.-]+)$/,
    summary: '-m/--model <name>, and -c <key>=<value> for model, model_provider, model_providers.*, model_reasoning_effort, model_reasoning_summary, model_verbosity, service_tier, windows.sandbox',
  },

  // Options must follow `resume <id>`: codex ignores -c overrides placed before it.
  // The user's extra arguments come first so the read-only settings after them win.
  buildArgs({ sessionId, disabledServers, threadSource, extraArgs }) {
    const args = ['exec'];
    if (sessionId) args.push('resume', sessionId);
    args.push('--json', '--skip-git-repo-check', ...extraArgs);
    if (threadSource) args.push('--thread-source', 'crosscheck');
    args.push(
      '-c', 'sandbox_mode=read-only',
      '-c', 'approval_policy=never',
      '-c', 'features.plugins=false',
      '-c', 'features.apps=false',
      '-c', 'features.memories=false',
      '-c', 'notify=[]',
    );
    for (const name of disabledServers) args.push('-c', `mcp_servers.${name}.enabled=false`);
    args.push('-');
    return args;
  },

  // Codex starts every MCP server in the user's config. A read-only reviewer needs
  // none of them, and MCP tools would sidestep the sandbox (or reach crosscheck
  // itself), so each is disabled by name. This fails closed: if the servers cannot
  // be listed, or one cannot be addressed in a -c override, the consultation is
  // refused. Tagging the thread lets crosscheck refuse calls made from inside a
  // consultation even though Codex filters the environment of MCP servers.
  async prepare(bin, cwd, options) {
    const [listing, help] = await Promise.all([
      capture(bin, [...bin.prefix, 'mcp', 'list', '--json', '-c', 'features.plugins=false'], cwd, options),
      codexHelp(bin, cwd, options),
    ]);
    const servers = parseServerList(listing);
    if (!servers) {
      throw new UserError('Could not list your Codex MCP servers (`codex mcp list --json` failed), so they cannot be disabled for the read-only consultation. Make sure that command works, then retry.');
    }
    const enabled = servers.filter((server) => server?.enabled !== false).map((server) => server?.name);
    const unaddressable = enabled.filter((name) => typeof name !== 'string' || !SERVER_KEY.test(name));
    if (unaddressable.length) {
      throw new UserError(`Your Codex MCP server ${unaddressable.map((name) => `"${name}"`).join(', ')} cannot be disabled for the read-only consultation, because its name cannot be used in a \`-c mcp_servers.<name>\` override. Rename it in your Codex config using only letters, digits, - _ : @ /, or disable it, then retry.`);
    }
    return { disabledServers: enabled, threadSource: Boolean(help?.includes('--thread-source')) };
  },

  createState() {
    return { sessionId: null, messages: [], activity: [], warnings: [], errors: [], usage: null, failed: null, ran: 0, startFailures: [] };
  },

  onEvent(state, event) {
    if (event.type === 'thread.started') state.sessionId = event.thread_id;
    else if (event.type === 'turn.completed') state.usage = event.usage;
    else if (event.type === 'turn.failed') state.failed = event.error?.message || 'turn failed';
    else if (event.type === 'error') state.errors.push(event.message);
    else if (event.type === 'item.completed') this.onItem(state, event.item ?? {});
  },

  onItem(state, item) {
    if (item.type === 'agent_message') {
      state.messages.push(item.text ?? '');
    } else if (item.type === 'command_execution') {
      const command = cleanCommand(item.command);
      if (item.exit_code === -1 || (item.exit_code == null && item.status === 'failed')) {
        state.startFailures.push(firstLine(item.aggregated_output));
        state.activity.push(`$ ${command} → failed to start`);
      } else if (item.status === 'declined') {
        state.activity.push(`$ ${command} → declined`);
      } else {
        state.ran += 1;
        state.activity.push(item.exit_code ? `$ ${command} → exit ${item.exit_code}` : `$ ${command}`);
      }
    } else if (item.type === 'mcp_tool_call') {
      state.activity.push(`mcp ${item.server}.${item.tool}${item.error ? ' → error' : ''}`);
    } else if (item.type === 'web_search') {
      state.activity.push(`web search: ${clip(item.query)}`);
    } else if (item.type === 'file_change') {
      state.warnings.push('Codex attempted to change files even though it was asked to stay read-only.');
    }
  },

  finish(state, { code, stderr, timedOut }) {
    const reply = state.messages.at(-1)?.trim() ?? '';
    const warnings = [...state.warnings];
    if (state.startFailures.length && state.ran === 0) {
      const hint = IS_WIN
        ? ' If this is a Windows sandbox setup error, set CROSSCHECK_CODEX_ARGS="-c windows.sandbox=unelevated" or repair the sandbox (see `codex doctor`).'
        : ' See `codex doctor`.';
      warnings.push(`Codex could not run any command (${state.startFailures[0]}), so it could not read the code: its reply is NOT grounded in the repository.${hint}`);
    }
    const usage = state.usage ? `${state.usage.input_tokens ?? '?'} in / ${state.usage.output_tokens ?? '?'} out tokens` : null;
    const base = { sessionId: state.sessionId, activity: state.activity, warnings, usage, model: null };
    if (timedOut) return { ...base, ok: false, reply, error: 'Codex did not finish before the timeout (CROSSCHECK_TIMEOUT_SEC).' };
    if (reply && !state.failed && code === 0) return { ...base, ok: true, reply };
    const reason = state.failed || state.errors.at(-1) || firstLine(stderr)
      || (code === 0 ? 'it produced no reply' : `codex exited with code ${code}`);
    return { ...base, ok: false, reply, error: `Codex failed: ${reason}` };
  },
};

function parseServerList(listing) {
  const start = listing?.indexOf('[') ?? -1;
  if (start < 0) return null;
  try {
    const servers = JSON.parse(listing.slice(start, listing.lastIndexOf(']') + 1));
    return Array.isArray(servers) ? servers : null;
  } catch {
    return null;
  }
}

let codexHelpText = null;

async function codexHelp(bin, cwd, options) {
  codexHelpText ??= await capture(bin, [...bin.prefix, 'exec', '--help'], cwd, options);
  return codexHelpText;
}

const claude = {
  key: 'claude',
  name: 'Claude',
  binName: 'claude',
  binEnv: 'CROSSCHECK_CLAUDE_BIN',
  argsEnv: 'CROSSCHECK_CLAUDE_ARGS',
  extraArgs: {
    flags: { '--model': 'value', '--effort': 'value', '--fallback-model': 'value', '--max-budget-usd': 'value' },
    summary: '--model, --effort, --fallback-model, --max-budget-usd',
  },

  // Plan mode keeps Claude read-only even when the user's settings allow writes.
  // --strict-mcp-config without --mcp-config starts it with no MCP servers, and
  // --setting-sources user ignores the reviewed repository's .claude/settings*.json,
  // whose hooks and permission rules would otherwise run with the user's rights.
  // On Windows, Claude Code may expose PowerShell instead of Bash; unknown names are ignored.
  buildArgs({ sessionId, extraArgs }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...extraArgs];
    if (sessionId) args.push('--resume', sessionId);
    args.push(
      '--permission-mode', 'plan',
      '--tools', 'Read,Grep,Glob,Bash,PowerShell',
      '--strict-mcp-config', '--disable-slash-commands',
      '--setting-sources', 'user',
    );
    return args;
  },

  async prepare() {
    return {};
  },

  createState() {
    return { sessionId: null, model: null, texts: [], activity: [], result: null };
  },

  onEvent(state, event, cwd) {
    if (event.type === 'system' && event.subtype === 'init') {
      state.sessionId = event.session_id ?? state.sessionId;
      state.model = event.model ?? null;
    } else if (event.type === 'assistant' && !event.parent_tool_use_id) {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') state.activity.push(describeClaudeTool(block, cwd));
        else if (block.type === 'text' && block.text?.trim()) state.texts.push(block.text);
      }
    } else if (event.type === 'result') {
      state.sessionId = event.session_id ?? state.sessionId;
      state.result = event;
    }
  },

  finish(state, { code, stderr, timedOut }) {
    const result = state.result;
    const warnings = (result?.permission_denials ?? []).map((denial) =>
      `Claude was blocked from running ${denial.tool_name}: ${clip(denial.tool_input?.command ?? JSON.stringify(denial.tool_input ?? {}))}`);
    const usage = typeof result?.total_cost_usd === 'number' ? `$${result.total_cost_usd.toFixed(4)} (session total)` : null;
    const base = { sessionId: state.sessionId, activity: state.activity, warnings, usage, model: state.model };
    const partial = state.texts.at(-1)?.trim() ?? '';
    if (timedOut) return { ...base, ok: false, reply: partial, error: 'Claude did not finish before the timeout (CROSSCHECK_TIMEOUT_SEC).' };
    const reply = typeof result?.result === 'string' ? result.result.trim() : '';
    if (result && !result.is_error && result.subtype === 'success' && reply) return { ...base, ok: true, reply };
    const reason = (result && (result.result || result.errors?.join('; ') || result.subtype))
      || firstLine(stderr) || `claude exited with code ${code}`;
    return { ...base, ok: false, reply: partial, error: `Claude failed: ${reason}` };
  },
};

function describeClaudeTool(block, cwd) {
  const input = block.input ?? {};
  switch (block.name) {
    case 'Read':
      return clip(`Read ${relativePath(cwd, input.file_path)}${input.offset ? `:${input.offset}` : ''}`);
    case 'Grep':
      return clip(`Grep ${JSON.stringify(input.pattern ?? '')}${input.path ? ` in ${relativePath(cwd, input.path)}` : ''}${input.glob ? ` (${input.glob})` : ''}`);
    case 'Glob':
      return clip(`Glob ${input.pattern ?? ''}${input.path ? ` in ${relativePath(cwd, input.path)}` : ''}`);
    case 'Bash':
    case 'PowerShell':
      return clip(`$ ${input.command ?? ''}`);
    default:
      return clip(`${block.name} ${JSON.stringify(input)}`);
  }
}

export const PEERS = { codex, claude };

export async function consultPeer(peer, { prompt, cwd, sessionId, timeoutMs, signal, onActivity, debug }) {
  const bin = resolveBinary(peer.binName, process.env[peer.binEnv]);
  if (!bin) {
    throw new UserError(`The ${peer.name} CLI ("${peer.binName}") was not found on PATH. Install it and log in, or set ${peer.binEnv} to its full path.`);
  }
  const extraArgs = parseExtraArgs(process.env[peer.argsEnv], peer.argsEnv, peer.extraArgs);
  const deadline = Date.now() + timeoutMs;
  const prepared = await peer.prepare(bin, cwd, { signal, timeoutMs });
  const args = [...bin.prefix, ...peer.buildArgs({ sessionId, extraArgs, ...prepared })];
  debug(`spawn ${bin.command} ${args.join(' ')} (cwd ${cwd})`);

  const state = peer.createState();
  let reported = 0;
  const run = await runProcess({
    bin, args, cwd, env: childEnv(), input: prompt, timeoutMs: Math.max(1, deadline - Date.now()), signal,
    onLine: (line) => {
      let event;
      try { event = JSON.parse(line); } catch { debug(`${peer.key}: ${line}`); return; }
      peer.onEvent(state, event, cwd);
      while (reported < state.activity.length) onActivity(state.activity[reported++]);
    },
  });
  if (run.stderr) debug(`${peer.key} stderr: ${run.stderr}`);
  return peer.finish(state, run);
}
