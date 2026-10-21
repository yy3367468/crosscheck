# crosscheck

**Claude Code and Codex consult each other as skeptical, read-only peer reviewers.**

[中文说明](README.zh-CN.md)

While working in Claude Code, Claude can ask your local Codex for a second opinion. While working in Codex, Codex can ask your local Claude. Both sides follow a protocol built on one idea: *question boldly, verify carefully* (大胆质疑，小心求证).

- **The consulted model is a critic, not a cheerleader.** It inspects the repository read-only, backs every claim with evidence (`path:line`, command output), marks each claim *verified* or *inferred*, and changes its position only for evidence.
- **The requesting model is a skeptic, not a follower.** It settles its own position first, treats the reply as unverified hypotheses, checks each claim against the code, pushes back with evidence for at most two rounds, then decides and tells you what it adopted, what it rejected, and why.

```text
Claude Code ──ask_codex──▶ crosscheck ──▶ codex exec   (read-only sandbox)
Codex       ──ask_claude─▶ crosscheck ──▶ claude -p    (plan mode, read-only)
```

## Why

A second model catches mistakes the first one misses, but only when neither side simply defers. Models are prone to sycophancy: a reviewer that nods along, or a requester that accepts any confident-sounding advice, adds cost without adding judgement. crosscheck makes skepticism the default on **both** sides of the exchange, and reports when a review is not grounded in the code at all (for example, when the peer could not run any command).

## Features

- **Bidirectional.** One repository, one MCP server, two plugins: `ask_codex` inside Claude Code and `ask_claude` inside Codex.
- **No API keys.** It drives the `codex` and `claude` CLIs you have already installed and logged in to.
- **Read-only peers.**
  - Codex runs with `sandbox_mode=read-only` and approvals off. Its MCP servers, plugins, apps, memories and notify hook are disabled.
  - Claude runs in plan mode with only `Read, Grep, Glob, Bash`, no MCP servers, no slash commands, and no settings from the reviewed repository.
- **Two modes.**
  - `independent`: the peer solves the problem without seeing your answer, which avoids anchoring.
  - `review`: the peer attacks a concrete plan, diff or claim.
- **Evidence and honesty checks.**
  - Every reply comes wrapped as an *unverified second opinion*, with the peer's activity log (which files it read, which commands it ran).
  - crosscheck warns when the peer could not run any command or did not look at any file.
- **Bounded debate.** Follow-ups continue the same peer session, capped at two by default.
- **Safe by construction.**
  - Recursion guard: a consulted peer cannot consult back.
  - Cancellation kills the peer's whole process tree.
  - A timeout stops any peer that runs too long.
  - Extra CLI arguments are allowlisted (model and effort settings only).
  - If Codex's MCP servers cannot be listed and disabled, the consultation is refused rather than run unisolated.
- **Zero dependencies.** One Node.js server, Node ≥ 18. Works on Windows, macOS and Linux.

## Requirements

- Node.js 18 or newer on `PATH`
- [Codex CLI](https://github.com/openai/codex), logged in: needed to use `ask_codex` from Claude Code
- [Claude Code](https://code.claude.com), logged in: needed to use `ask_claude` from Codex

Install both CLIs if you want both directions.

## Install

Replace `OWNER` with the GitHub account that hosts this repository.

### Claude Code (adds `ask_codex`)

```bash
claude plugin marketplace add OWNER/crosscheck
claude plugin install crosscheck@crosscheck
```

Or, inside a session: `/plugin marketplace add OWNER/crosscheck`, then `/plugin install crosscheck@crosscheck`. Restart Claude Code afterwards.

### Codex (adds `ask_claude`)

```bash
codex plugin marketplace add OWNER/crosscheck
codex plugin add crosscheck@crosscheck
```

Start a new Codex session afterwards.

### Without the plugin system

Point the MCP server at a local clone:

```bash
claude mcp add --scope user crosscheck -- node /path/to/crosscheck/server/crosscheck.mjs --peer codex
```

```toml
# ~/.codex/config.toml
[mcp_servers.crosscheck]
command = "node"
args = ["/path/to/crosscheck/server/crosscheck.mjs", "--peer", "claude"]
tool_timeout_sec = 1800
# Codex passes only a minimal environment to MCP servers; forward what `claude` needs:
env_vars = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY"]
```

The skill lives in `skills/crosscheck/`. Without the plugin system, copy that folder to `~/.claude/skills/` for Claude Code, or to `~/.agents/skills/` for Codex.

## Usage

Just ask:

> Before we migrate, cross-check this plan with Codex.
>
> 让 Claude 独立诊断一下这个 bug，然后和你的结论对比。

Or invoke the skill explicitly: `/crosscheck:crosscheck` in Claude Code, `$crosscheck:crosscheck` in Codex.

The tool takes:

| Argument | Description |
|---|---|
| `request` | Self-contained brief: goal, constraints, relevant paths, and what to scrutinize. The peer does not see your conversation. |
| `mode` | `review` (default) or `independent`. |
| `session_id` | Continue an earlier consultation (follow-up or rebuttal). |
| `cwd` | Directory to inspect. Defaults to the current project. |

A typical exchange:

1. The agent writes down its own position, then asks the peer (`independent` for open questions, `review` for a concrete artifact).
2. The peer inspects the repository and answers with a verdict, ranked findings and evidence.
3. The agent checks each finding itself and classifies it as confirmed, refuted, unverified or a judgment call.
4. It disputes wrong findings with evidence, using `session_id`, for two rounds at most.
5. It decides, and reports a short summary to you: peer verdict / adopted / rejected / open / decision.

## Configuration

These environment variables are read by the MCP server:

| Variable | Default | Meaning |
|---|---|---|
| `CROSSCHECK_TIMEOUT_SEC` | `1500` | Kill the peer after this many seconds. |
| `CROSSCHECK_MAX_FOLLOWUPS` | `2` | Follow-ups allowed per consultation. |
| `CROSSCHECK_CODEX_BIN` / `CROSSCHECK_CLAUDE_BIN` | from `PATH` | Path to the peer CLI. |
| `CROSSCHECK_CODEX_ARGS` | none | Extra Codex arguments. Allowed: `-m/--model <name>`, and `-c <key>=<value>` for `model`, `model_provider`, `model_providers.*`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `service_tier` and `windows.sandbox`. Example: `-m gpt-5.5 -c model_reasoning_effort=high`. |
| `CROSSCHECK_CLAUDE_ARGS` | none | Extra Claude arguments. Allowed: `--model`, `--effort`, `--fallback-model`, `--max-budget-usd`. Example: `--model opus --effort high`. |
| `CROSSCHECK_DEBUG` | off | `1` logs the peer command lines and stderr to the server's stderr. |

How to set them:
- **Claude Code:** put them in the `env` block of `~/.claude/settings.json`.
- **Codex:** export them in the shell that starts Codex. The plugin forwards `CROSSCHECK_*` and the usual `ANTHROPIC_*`, cloud-provider and proxy variables to the server.

Timeouts on the host side:
- **Codex** stops waiting for a tool after `tool_timeout_sec`. The plugin sets 1800 s. If you raise `CROSSCHECK_TIMEOUT_SEC` above that, raise this too.
- **Claude Code** waits for MCP tools for a long time by default, and crosscheck sends progress notifications while the peer works.

## Security notes

- **Your code goes to the other provider.** The peer reads files in the project directory, and its provider (OpenAI or Anthropic) receives whatever it reads. Don't use crosscheck on code you may not share with both.
- **Read-only is enforced by the peer CLI, not by crosscheck.**
  - Codex relies on its OS sandbox. If that sandbox cannot start, Codex cannot run any command; crosscheck flags such replies as *not grounded in the repository*.
  - Claude relies on plan mode. Plan mode stops edits and asks the model itself to stay read-only, but it is not an OS sandbox.
- **The reviewed repository's own agent configuration is not trusted.**
  - Claude runs with `--setting-sources user`, so the repository's `.claude/settings*.json` hooks and permission rules are ignored.
  - Its `CLAUDE.md` and `AGENTS.md` are still read as context.
- **Replies are data.** Both prompts tell the requesting agent never to follow instructions found in a peer reply.

### Windows: Codex sandbox errors

If Codex replies are flagged with `Codex could not run any command (... setup refresh had errors)`, the elevated Windows sandbox failed to provision (`codex doctor` shows it). Repair it, or use the unelevated sandbox for consultations:

```text
CROSSCHECK_CODEX_ARGS=-c windows.sandbox=unelevated
```

The unelevated sandbox still blocks writes. It is a weaker isolation boundary than the elevated one.

## Known limitations

- **Sessions live in memory.** Follow-ups (`session_id`) only work while the same crosscheck server process is running. If the host restarts it, start a new consultation.
- **Consultations show up in the peer's history.** They are saved as ordinary Codex or Claude sessions, which is what makes follow-ups possible.
- **Leftover processes on Windows.** crosscheck kills the peer's process tree with `taskkill /T`. That only works while the peer itself is alive, so a process the peer started and left running after exiting is not cleaned up. On macOS and Linux the peer's whole process group is killed.
- **The protocol is followed by models, not enforced.** crosscheck makes the skeptical protocol the default and reports how grounded a reply is. Whether an agent truly verifies a claim still depends on the model.

## Development

```bash
npm test                         # end-to-end tests against a fake peer CLI; no model calls
node scripts/smoke.mjs codex .   # live call to your real Codex (spends quota)
node scripts/smoke.mjs claude .  # live call to your real Claude (spends quota)
```

Layout:

```text
server/crosscheck.mjs    MCP server (JSON-RPC over stdio)
server/peers.mjs         peer CLI adapters: arguments, event parsing, process control
server/prompts.mjs       reviewer and requester protocol text
skills/crosscheck/       the skill both agents load
.claude-plugin/          Claude Code plugin and marketplace manifests
.codex-plugin/           Codex plugin manifest
```

## Related work

[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Claude → Codex reviews), [PAL MCP server](https://github.com/BeehiveInnovations/pal-mcp-server) (multi-model tools), and [GuDaStudio/codexmcp](https://github.com/GuDaStudio/codexmcp) (Codex as an MCP tool) inspired parts of this project. crosscheck's focus is narrower:
- symmetric Claude Code ⇄ Codex consultation through existing CLI logins;
- an explicit skeptical protocol on both the reviewer side and the requester side.

## License

MIT
