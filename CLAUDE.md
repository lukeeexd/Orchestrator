# Orchestrator

Windows desktop app (Electron + React + TypeScript) for orchestrating Claude / Codex agents with distinct roles. Drives the user's installed `claude` (and optionally `codex`) CLI — no agent SDK bundled.

## Orient yourself before starting work

- **[`PLAN.md`](./PLAN.md)** — architecture overview + locked decisions. Read first.
- **[`BACKLOG.md`](./BACKLOG.md)** — open work + recently shipped slices. Read second.
- **[`LAYERS.md`](./LAYERS.md)** — process-boundary rules (which `src/` subdir can import from which). Lint-enforced.
- **[`docs/design/README.md`](./docs/design/README.md)** — UI handoff; read before any frontend work.
- **[GitHub Releases](https://github.com/lukeeexd/Orchestrator/releases)** — per-release feature log. Each tag's annotated body is the source of truth for what shipped when.

## Release cadence

Roughly one minor every couple of days. Each release is a self-contained bundle. Feature work → minor bump, bug fix → patch bump. Curated release notes live in the annotated tag body (`git tag -a vX.Y.Z -m "..."`), which the release workflow lifts into the GitHub Release.
