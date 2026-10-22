# Changelog

## 0.2.0 (2026-10-22)

- Windows: Claude consultations can run shell commands again. Claude Code on Windows exposes `PowerShell` instead of `Bash`, so `--tools` now lists both.
- Claude no longer tries to write a plan file or call ExitPlanMode in plan mode; the reviewer rules say the reply is the deliverable.
- Activity lines show the command itself: nested shell quoting (e.g. PowerShell's `'"'"'`) is undone.
- macOS: activity paths are shown relative to the workspace even when the peer reports symlink-resolved paths (`/private/var`).
- Paths inside a subdirectory whose name starts with `..` (e.g. `..foo/`) are shown relative to the workspace instead of absolute.
- README: an early-release notice (what was tested live, read-only strength per side, quota cost), and in the Chinese README a note on installing without access to github.com.

## 0.1.0

First release.

- MCP server `server/crosscheck.mjs` with a single tool:
  - `ask_codex` when run with `--peer codex`, for Claude Code;
  - `ask_claude` when run with `--peer claude`, for Codex.
- Read-only peers:
  - Codex runs in its read-only sandbox, with MCP servers, plugins, apps, memories and notify disabled.
  - Claude runs in plan mode with `Read, Grep, Glob, Bash` (`PowerShell` on Windows) only, no MCP servers, and user-level settings only.
- `review` and `independent` modes, follow-ups through `session_id` (2 by default), progress notifications, cancellation, and a timeout.
- Recursion guard, host-session environment scrubbing, and an allowlist for extra CLI arguments (model and effort settings only).
- MCP isolation fails closed: if Codex's MCP servers cannot be listed, the consultation is refused.
- Warnings when the peer could not run any command, did not inspect anything, or was blocked by its permissions.
- The `crosscheck` skill: a skeptical verification protocol for the requesting agent.
- Claude Code plugin and marketplace manifests, and a Codex plugin manifest, in one repository.
