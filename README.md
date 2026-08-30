# Stop Review

A Stop hook for Codex, Claude Code, and Ghost that continues a turn when work
remains.

## Prerequisites

You must implement an advisor sub-agent before installing Stop Review. Follow
[Anthropic's advisor pattern](https://www.anthropic.com/webinars/building-on-the-claude-platform-claude-fable-5-and-model-orchestration-patterns).
Stop Review can tell the current agent to consult the advisor, but it does not
provide the advisor itself.

- Node.js 22+
- `codex`, `claude`, or `ghostd` installed locally
- Ghost only: `ghostd hook-smol-complete` support

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
