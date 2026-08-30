# Stop Review

Stop Review is a small lifecycle hook for Codex, Claude Code, and Ghost. Before an
assistant turn stops, it classifies only the last assistant message:

- `CONTINUE` — required work remains that the agent can perform now.
- `CONSULT` — an unresolved question can be answered by an advisor.
- `STOP` — work is complete, or progress requires the user or external state.

The model returns one word. A strict Zod enum validates it, and the hook constructs
the host response:

| Verdict | Hook output |
| --- | --- |
| `CONTINUE` | `{"decision":"block","reason":"Please continue."}` |
| `CONSULT` | `{"decision":"block","reason":"Please consult the advisor, then continue."}` |
| `STOP` | `{}` |

## Install for Codex

Add this repository as a Codex marketplace, then install the plugin:

```bash
codex plugin marketplace add ferdousbhai/stop-review --ref v0.1.0
codex plugin add stop-review@stop-review
```

Start a new Codex session after installation. The plugin bundles its dependencies;
you do not need to clone the repository or run `npm install`.

## Install for Claude Code

```bash
npx --yes github:ferdousbhai/stop-review#v0.1.0 --claude
```

The installer copies the bundled hook to `~/.local/share/stop-review/` and merges a
`Stop` command hook into `~/.claude/settings.json`. Existing settings and unrelated
hooks are preserved.

Uninstall it with:

```bash
npx --yes github:ferdousbhai/stop-review#v0.1.0 --uninstall --claude
```

## Install for Ghost

Ghost must already be installed, and `ghostd hook-smol-complete` must run successfully.
Then install the `session_stop` hook:

```bash
npx --yes github:ferdousbhai/stop-review#v0.1.0 --ghost
```

Uninstall it with:

```bash
npx --yes github:ferdousbhai/stop-review#v0.1.0 --uninstall --ghost
```

Use `--all` instead of `--claude` or `--ghost` to configure both runtimes.

## Configuration

The defaults match the original hook:

| Variable | Default | Purpose |
| --- | --- | --- |
| `STOP_REVIEW_CODEX_MODEL` | `gpt-5.6-luna` | Codex reviewer model |
| `STOP_REVIEW_CLAUDE_MODEL` | `sonnet` | Claude reviewer model |
| `STOP_REVIEW_CODEX_BIN` | `codex` | Codex executable |
| `STOP_REVIEW_CLAUDE_BIN` | `claude` | Claude executable |
| `STOP_REVIEW_GHOST_BIN` | `ghostd` | Ghost daemon executable |
| `STOP_REVIEW_AUDIT_LOG` | unset | Optional JSONL verdict log |

The legacy `CODEX_STOP_REVIEW_*_BIN` executable variables remain supported.

## Privacy and safety

- Only `last_assistant_message` is sent to the reviewer.
- User messages, tool history, project files, and GitHub issues are not reviewer context.
- Transcript files are read only to enforce the per-turn continuation cap of 10.
- Common token and secret patterns are redacted from the reviewed message.
- Codex runs its reviewer with hooks disabled, approval disabled, and a read-only sandbox.
- Claude runs with tools disabled and no session persistence.
- Invalid model output and reviewer failures fail open instead of trapping the session.
- Audit logging is opt-in.

The reviewed assistant message is still sent to the selected model provider through
that provider's locally authenticated CLI. Do not install the hook if that is
incompatible with your data policy.

## Develop and test

Requires Node.js 22 or newer.

```bash
npm ci
npm run check
```

`npm run build` bundles the source and Zod into the executable committed at
`plugins/stop-review/scripts/stop-review.mjs`. Tests cover the three verdicts, exact
output mapping, Codex and Claude invocation, Ghost bridging, continuation limits,
transcript confinement, redaction, and installer idempotence.

## Repository layout

```text
.agents/plugins/marketplace.json       Codex marketplace
plugins/stop-review/                   Installable Codex plugin
src/stop-review.mjs                    Reviewer source
scripts/build.mjs                      Bundle builder
scripts/install.mjs                    Claude Code and Ghost installer
test/                                  Automated tests
```

## License

[MIT](LICENSE)
