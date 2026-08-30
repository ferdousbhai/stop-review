# Stop Review

A Stop hook for Codex, Claude Code, and Ghost. It reviews only the last assistant
message and continues the turn when required work remains.

## Install

### Codex

```bash
codex plugin marketplace add ferdousbhai/stop-review --ref v0.1.0
codex plugin add stop-review@stop-review
```

Start a new Codex session after installation.

### Claude Code

```bash
npx --yes github:ferdousbhai/stop-review#v0.1.0 --claude
```

### Ghost

```bash
npx --yes github:ferdousbhai/stop-review#v0.1.0 --ghost
```

Use `--all` to install both Claude Code and Ghost. Add `--uninstall` to remove
either integration. The installer preserves unrelated settings and hooks.

## How it works

The reviewer returns one validated word:

| Verdict | Result |
| --- | --- |
| `CONTINUE` | Continue the current agent |
| `CONSULT` | Consult the advisor, then continue |
| `STOP` | Accept the stop |

Only `last_assistant_message` is sent to the reviewer. Transcripts are read only
to enforce a continuation cap of 10; user messages, tools, project files, and
GitHub issues are never reviewer context. Invalid output and reviewer errors fail
open.

## Requirements and configuration

- Node.js 22+
- The selected local CLI: `codex`, `claude`, or `ghostd`
- Ghost must support `ghostd hook-smol-complete`

Optional environment variables:

```text
STOP_REVIEW_CODEX_MODEL       default: gpt-5.6-luna
STOP_REVIEW_CLAUDE_MODEL      default: sonnet
STOP_REVIEW_CODEX_BIN         default: codex
STOP_REVIEW_CLAUDE_BIN        default: claude
STOP_REVIEW_GHOST_BIN         default: ghostd
STOP_REVIEW_AUDIT_LOG         optional JSONL audit path
```

## Development

```bash
npm ci
npm run check
```

MIT licensed.
