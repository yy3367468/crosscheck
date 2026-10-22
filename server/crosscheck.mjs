#!/usr/bin/env node
// crosscheck: an MCP server that lets one AI coding agent consult another
// (Claude Code <-> Codex) as a skeptical, read-only peer reviewer.
//
//   node crosscheck.mjs --peer codex    # run inside Claude Code, exposes ask_codex
//   node crosscheck.mjs --peer claude   # run inside Codex, exposes ask_claude
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PEERS, UserError, CancelledError, consultPeer, killAll } from './peers.mjs';
import { buildConsultPrompt, buildFollowupPrompt, toolDescription, SERVER_INSTRUCTIONS } from './prompts.mjs';

const VERSION = '0.2.0';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const HEARTBEAT_MS = 15_000;
const MAX_ACTIVITY_SHOWN = 20;
const MAX_REPLY_CHARS = 50_000;
const MODES = ['review', 'independent'];

const peer = PEERS[readPeerArg(process.argv.slice(2))];
if (!peer) {
  process.stderr.write('usage: crosscheck.mjs --peer codex|claude\n');
  process.exit(2);
}

const config = {
  timeoutMs: positive(process.env.CROSSCHECK_TIMEOUT_SEC, 1500) * 1000,
  maxFollowups: nonNegativeInt(process.env.CROSSCHECK_MAX_FOLLOWUPS, 2),
  depth: Number(process.env.CROSSCHECK_DEPTH) || 0,
};
const debug = process.env.CROSSCHECK_DEBUG === '1'
  ? (message) => process.stderr.write(`[crosscheck] ${message}\n`)
  : () => {};

const toolName = `ask_${peer.key}`;
const sessions = new Map(); // peer session id -> { cwd, followups }
const inflight = new Map(); // JSON-RPC request id -> AbortController

function readPeerArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--peer') return argv[i + 1];
    if (argv[i].startsWith('--peer=')) return argv[i].slice('--peer='.length);
  }
  return undefined;
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function handleMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return replyError(null, -32700, 'Parse error');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return replyError(null, -32600, 'Invalid Request');
  const { id, method, params } = message;
  if (typeof method !== 'string') return; // a response to a request we never sent
  if (id === undefined || id === null) return handleNotification(method, params);

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        // codex/sandbox-state-meta makes Codex attach its sandbox cwd to each call,
        // which is how we find the user's project when launched from a plugin dir.
        capabilities: { tools: { listChanged: false }, experimental: { 'codex/sandbox-state-meta': {} } },
        serverInfo: { name: 'crosscheck', title: 'crosscheck', version: VERSION },
        instructions: config.depth > 0 ? undefined : SERVER_INSTRUCTIONS,
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: config.depth > 0 ? [] : [toolDefinition()] });
    case 'tools/call':
      return void handleToolCall(id, params ?? {});
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

function handleNotification(method, params) {
  if (method === 'notifications/cancelled') inflight.get(params?.requestId)?.abort();
}

function toolDefinition() {
  return {
    name: toolName,
    title: `Ask ${peer.name} for a skeptical second opinion`,
    description: toolDescription(peer.name, config.maxFollowups),
    inputSchema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'Self-contained brief for the peer: goal, context, constraints, relevant file paths, and exactly what to scrutinize or answer. In review mode include the plan, diff or claim. In independent mode describe the problem but not your own answer. For a follow-up: the points you dispute and your evidence.',
        },
        mode: {
          type: 'string',
          enum: MODES,
          default: 'review',
          description: '"review" (default): critique a concrete proposal. "independent": solve the problem from scratch without seeing your answer. Ignored for follow-ups.',
        },
        session_id: {
          type: 'string',
          description: 'Continue an earlier consultation (follow-up or rebuttal) using the session_id that call returned.',
        },
        cwd: {
          type: 'string',
          description: 'Directory the peer should inspect. Defaults to the current project.',
        },
      },
      required: ['request'],
      additionalProperties: false,
    },
    annotations: {
      title: `Ask ${peer.name}`,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

async function handleToolCall(id, params) {
  if (params.name !== toolName) return replyError(id, -32602, `Unknown tool: ${params.name}`);
  const meta = params._meta ?? {};
  const guard = recursionGuard(meta);
  if (guard) return reply(id, toolError(guard));

  let input;
  try {
    input = parseInput(params.arguments ?? {}, meta);
  } catch (err) {
    return reply(id, toolError(err.message));
  }

  if (input.session?.busy) {
    return reply(id, toolError('This consultation is already answering another call. Wait for it to finish before following up.'));
  }
  if (input.session) input.session.busy = true;
  const controller = new AbortController();
  inflight.set(id, controller);
  const progress = progressReporter(meta.progressToken);
  const started = Date.now();
  try {
    const result = await consultPeer(peer, {
      prompt: input.session
        ? buildFollowupPrompt({ request: input.request })
        : buildConsultPrompt({ mode: input.mode, request: input.request, cwd: input.cwd }),
      cwd: input.cwd,
      sessionId: input.sessionId,
      timeoutMs: config.timeoutMs,
      signal: controller.signal,
      onActivity: progress.activity,
      debug,
    });
    let followupsLeft = null;
    if (result.ok && result.sessionId) {
      const session = input.session ?? { cwd: input.cwd, followups: -1 };
      session.followups += 1;
      sessions.set(result.sessionId, session);
      followupsLeft = config.maxFollowups - session.followups;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const text = formatResult(result, { seconds, followupsLeft, cwd: input.cwd });
    reply(id, { content: [{ type: 'text', text }], isError: !result.ok });
  } catch (err) {
    if (err instanceof CancelledError) return; // the client gave up on this request; no response is expected
    reply(id, toolError(err instanceof UserError ? err.message : `crosscheck internal error: ${err?.stack ?? err}`));
  } finally {
    progress.stop();
    inflight.delete(id);
    if (input.session) input.session.busy = false;
  }
}

function recursionGuard(meta) {
  // Inside a consultation the peer must not consult back. Claude passes our env
  // marker through to MCP servers; Codex filters MCP server env, so its children
  // are recognized by the thread source crosscheck tags them with instead.
  const nested = config.depth > 0 || meta['x-codex-turn-metadata']?.thread_source === 'crosscheck';
  return nested ? 'crosscheck is disabled inside a crosscheck consultation (recursion guard). Answer from your own analysis.' : null;
}

function parseInput(args, meta) {
  const request = typeof args.request === 'string' ? args.request.trim() : '';
  if (!request) throw new UserError('"request" is required: a self-contained brief for the peer.');
  const mode = args.mode ?? 'review';
  if (!MODES.includes(mode)) throw new UserError(`"mode" must be one of: ${MODES.join(', ')}.`);

  const sessionId = typeof args.session_id === 'string' && args.session_id.trim() ? args.session_id.trim() : null;
  let session = null;
  if (sessionId) {
    session = sessions.get(sessionId);
    if (!session) {
      throw new UserError(`Unknown session_id "${sessionId}". Only consultations started by this crosscheck server can be continued; start a new one without session_id.`);
    }
    if (session.followups >= config.maxFollowups) {
      throw new UserError(`Follow-up limit reached (${config.maxFollowups}) for this consultation. Decide yourself based on the evidence, and tell the user where you and ${peer.name} still disagree.`);
    }
  }
  return { request, mode, sessionId, session, cwd: session?.cwd ?? resolveCwd(args.cwd, meta) };
}

// The project directory: Codex reports it per call (a Codex plugin server runs in
// the plugin's own directory), Claude Code sets CLAUDE_PROJECT_DIR and starts
// servers in the project.
function resolveCwd(requested, meta) {
  const base = codexProjectDir(meta) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dir = typeof requested === 'string' && requested.trim() ? path.resolve(base, requested.trim()) : path.resolve(base);
  let stat;
  try { stat = fs.statSync(dir); } catch {}
  if (!stat?.isDirectory()) throw new UserError(`Working directory not found: ${dir}`);
  return dir;
}

function codexProjectDir(meta) {
  const uri = meta['codex/sandbox-state-meta']?.sandboxCwd;
  if (typeof uri === 'string' && uri) {
    try {
      return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
    } catch {}
  }
  const workspaces = meta['x-codex-turn-metadata']?.workspaces;
  const first = workspaces && typeof workspaces === 'object' ? Object.keys(workspaces)[0] : null;
  return first || null;
}

function progressReporter(token) {
  if (token === undefined || token === null) return { activity() {}, stop() {} };
  const started = Date.now();
  let count = 0;
  const notify = (message) => send({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken: token, progress: ++count, message },
  });
  const timer = setInterval(() => notify(`${peer.name} is working (${Math.round((Date.now() - started) / 1000)}s)`), HEARTBEAT_MS);
  timer.unref();
  return {
    activity: (text) => notify(`${peer.name}: ${text}`),
    stop: () => clearInterval(timer),
  };
}

function formatResult(result, { seconds, followupsLeft, cwd }) {
  const name = peer.name;
  const lines = [result.ok
    ? `${name} replied after ${seconds}s. This is an unverified second opinion: check each claim against the code before acting on it.`
    : `${name} consultation failed after ${seconds}s. ${result.error}`];
  lines.push(`Working directory: ${cwd}`);

  if (result.reply) {
    const tag = `${name.toUpperCase()} REPLY`;
    const text = result.reply.length > MAX_REPLY_CHARS
      ? `${result.reply.slice(0, MAX_REPLY_CHARS)}\n[… truncated by crosscheck: ${result.reply.length - MAX_REPLY_CHARS} more characters]`
      : result.reply;
    lines.push('', `===== BEGIN ${tag} =====`, text, `===== END ${tag} =====`);
  }

  const warnings = [...result.warnings];
  if (result.ok && result.activity.length === 0) {
    warnings.push(`${name} did not open any files or run any commands; its reply rests only on your brief.`);
  }

  lines.push('');
  if (followupsLeft !== null) {
    lines.push(followupsLeft > 0
      ? `session_id: ${result.sessionId} (to dispute or clarify, call again with it and your evidence; ${followupsLeft} follow-up${followupsLeft === 1 ? '' : 's'} left)`
      : `session_id: ${result.sessionId} (no follow-ups left: decide yourself based on the evidence)`);
  }
  const facts = [result.model && `model ${result.model}`, result.usage && `usage ${result.usage}`].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '));
  if (warnings.length) lines.push('Warnings:', ...warnings.map((w) => `- ${w}`));
  if (result.activity.length) {
    lines.push(`${name} activity (${result.activity.length}):`, ...result.activity.slice(0, MAX_ACTIVITY_SHOWN).map((a) => `- ${a}`));
    if (result.activity.length > MAX_ACTIVITY_SHOWN) lines.push(`- … and ${result.activity.length - MAX_ACTIVITY_SHOWN} more`);
  }
  return lines.join('\n').trimEnd();
}

function shutdown() {
  killAll();
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => { if (line.trim()) handleMessage(line); });
rl.on('close', shutdown);
process.stdout.on('error', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
debug(`started: peer=${peer.key} depth=${config.depth} cwd=${process.cwd()}`);
