# Changelog

## 0.1.0

First release.

- MCP server `server/crosscheck.mjs` with a single tool:
  - `ask_codex` when run with `--peer codex`, for Claude Code;
  - `ask_claude` when run with `--peer claude`, for Codex.
- Read-only peers:
  - Codex runs in its read-only sandbox, with MCP servers, plugins, apps, memories and notify disabled.
  - Claude runs in plan mode with `Read, Grep, Glob, Bash` only, no MCP servers, and user-level settings only.
- `review` and `independent` modes, follow-ups through `session_id` (2 by default), progress notifications, cancellation, and a timeout.
- Recursion guard, host-session environment scrubbing, and an allowlist for extra CLI arguments (model and effort settings only).
- MCP isolation fails closed: if Codex's MCP servers cannot be listed, the consultation is refused.
- Warnings when the peer could not run any command, did not inspect anything, or was blocked by its permissions.
- The `crosscheck` skill: a skeptical verification protocol for the requesting agent.
- Claude Code plugin and marketplace manifests, and a Codex plugin manifest, in one repository.
