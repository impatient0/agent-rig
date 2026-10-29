# agent-rig

Subagent-first, platform-agnostic workflow rig for agentic software engineering:
dual-protocol `PreToolUse` guards, a **Tech Lead → Isolated Worker → Cold Verifier** dispatch pipeline, git worktree isolation locks, and documentation graph linters.
See [`docs/field-notes.md`](docs/field-notes.md) for the real-world failure modes and post-mortems behind each mechanism.

## Design Stance: Audience of One

This rig is built for its author first and published in case its mechanisms are useful to you.
Where universal appeal conflicts with keeping the author's workflow sharp—such as requiring cold Verifier subagents in [`skills/dispatch/SKILL.md`](skills/dispatch/SKILL.md) or parking the root checkout on a detached `HEAD`—universal appeal loses every time.
When you want a lighter setup on a specific repo, use CLI flags (`rig init --no-worktrees`) rather than weakening the defaults.

---

## Quick Start

### 1. Global Bootstrap Across Your Harnesses (`rig install-global`)

Scan your home directory for installed harnesses (`~/.gemini` for Antigravity, `~/.claude` for Claude Code, `~/.codex` for Codex CLI, `~/.cursor` for Cursor) and interactively choose where to install the rig globally:

```bash
node /path/to/agent-rig/bin/rig.mjs install-global
# Or non-interactively for specific harnesses:
node /path/to/agent-rig/bin/rig.mjs install-global --harnesses antigravity,claude
# Or install into all detected harnesses:
node /path/to/agent-rig/bin/rig.mjs install-global --detected
```

What `rig install-global` configures:
- **Antigravity (`~/.gemini/config/`):**
  Registers `agent-rig` in `~/.gemini/config/plugins.json` and links `~/.gemini/config/plugins/agent-rig`, automatically activating [`rules/AGENTS.md`](rules/AGENTS.md), all 6 skills under `skills/`, and the `PreToolUse` guards in `hooks.json` across every project you open—with zero files copied into your project repos.
- **Claude Code (`~/.claude/`):**
  Symlinks the 6 skills into `~/.claude/skills/`, the rules into `~/.claude/rules/`, and the `PreToolUse` guards into `~/.claude/hooks/`, and non-destructively merges the hook entries into `~/.claude/settings.json`.
  (Alternatively, in Claude Code you can run `/plugin marketplace add impatient0/agent-rig` and `/plugin install agent-rig@agent-rig`.)
- **Codex CLI (`~/.codex/`) & Cursor (`~/.cursor/`):**
  Symlinks the portable skills and global rules.

### 2. Run Documentation Linters on Any Repository (Zero Repo Footprint)

Once `rig` is linked on your `PATH` (`npm link` inside `agent-rig`), you can verify or format any project's Markdown docs without copying scripts into that project:

```bash
rig check-docs /path/to/your-project
rig reflow-docs /path/to/your-project --check
```

### 3. Initialize a Repository for Worktree Isolation & Backlog Tracking (`rig init`)

When starting a project that should enforce worktree commit locks and carry its own [`docs/backlog.md`](docs/backlog.md) and ADR log ([`docs/adr/0001-record-architecture-decisions.md`](docs/adr/0001-record-architecture-decisions.md)):

```bash
rig init /path/to/your-project
```

By default, `rig init` is **lightweight** (relying on your global `rig install-global` setup for skills and `PreToolUse` hooks):
1. Installs `scripts/git-hooks/pre-commit` and `scripts/git-hooks/pre-merge-commit` and sets `git config core.hooksPath scripts/git-hooks`.
2. Scaffolds a minimal `AGENTS.md` (`templates/AGENTS.md`), [`docs/backlog.md`](docs/backlog.md), and [`docs/adr/0001-record-architecture-decisions.md`](docs/adr/0001-record-architecture-decisions.md) if missing.
3. Parks the root checkout on a detached `HEAD` at `main` if the working tree is clean (or run `rig detach` after committing the scaffolded files).

Flags for `rig init`:
- `--self-contained` — Also copy `skills/`, `rules/`, `hooks/`, `scripts/check-doc-links.mjs`, and `scripts/reflow-docs.mjs` directly into the target repository for team/CI sharing.
- `--no-worktrees` — Skip git worktree hooks and detached-`HEAD` setup.
- `--ui` — Also copy `templates/docs/design/mockup-scaffold.html`.
- `--force` — Overwrite existing files.

---

## What's Inside

### 1. Subagent-First Skills (`skills/`)

- [`dispatch`](skills/dispatch/SKILL.md) — **Tech Lead → Isolated Worker → Cold Verifier** pipeline:
  splits candidate tasks into **Bucket 1 (Dispatch Now)** and **Bucket 2 (Ask User First)**, dispatches Workers in isolated git worktrees (`Workspace: "share"` in Antigravity; `isolation: "worktree"` in Claude Code) under five stop triggers and `Unmandated-call:` commit trailers, and spawns a fresh read-only Verifier subagent to audit every diff cold before merge.
- [`wrap-up`](skills/wrap-up/SKILL.md) — End-of-session checkpoint:
  verifies worktree state and test gates, routes trapped conversation decisions to ADRs or [`docs/backlog.md`](docs/backlog.md), and verifies cold-session reachability.
- [`backlog-audit`](skills/backlog-audit/SKILL.md) — Sorts `Unranked` items in [`docs/backlog.md`](docs/backlog.md) into six actionability tiers after checking existing ADRs for prior rejections.
- [`doc-audit`](skills/doc-audit/SKILL.md) — Detects files that mix stable architectural invariants with chronological slice logs, eliminates duplicated prose, and verifies claims against code.
- [`merge-to-main`](skills/merge-to-main/SKILL.md) — Uses `git switch main` inside a linked worktree as an atomic mutex lock, runs the verification suite on the uncommitted merge, commits, and immediately re-detaches `HEAD`.
- [`secure-credential-handoff`](skills/secure-credential-handoff/SKILL.md) — Mode-`0600` env-file pattern so secrets never enter the chat transcript.

### 2. Dual-Protocol Mechanical Guards (`hooks/` & `scripts/git-hooks/`)

- `hooks/lib/hook-io.mjs` — Documented `PreToolUse` JSON schema adapter supporting Antigravity (`toolCall.args` → `{ decision, reason }`), Claude Code (`tool_input` → `{ hookSpecificOutput }`), and explicit `--harness=<name>` flags.
- `hooks/guard-remote-mutation.mjs` — Prompts (`ask`) before any command that mutates state outside the working tree (`ssh`, `scp`, `rsync`, `crontab`, `docker -H`, `git push` to `main`, or mutating `gh` subcommands).
- `hooks/guard-main-checkout-edits.mjs` — Refuses (`deny`) file edits in the root checkout with harness-appropriate worktree instructions.
- `hooks/guard-symlinked-node-modules.mjs` — Refuses (`deny`) `npm`, `pnpm`, `yarn`, and `bun` installs when the target directory's `node_modules` is a shared symlink (including `cd .worktrees/<slug> && npm install` chains).
- `scripts/git-hooks/pre-commit` and `scripts/git-hooks/pre-merge-commit` — Refuse commits or merges in the root checkout and refuse direct commits on `main` outside a merge.

### 3. Documentation Graph Linters (`scripts/`)

- `scripts/check-doc-links.mjs` — Enforces resolved relative links and `#fragment` headings, bans wiki-style refs/globs/bare backticked doc paths, verifies reachability from [`README.md`](README.md) / [`AGENTS.md`](AGENTS.md) / skills / rules, verifies cited repo paths exist on disk, and enforces ADR byte budgets.
- `scripts/reflow-docs.mjs` — Normalizes Markdown files to one sentence per line.

---

## Testing

```bash
npm test
```

`npm test` runs the full `node:test` suite (`tests/hookIo.test.mjs`, `tests/guard-remote-mutation.test.mjs`, `tests/guard-main-checkout-edits.test.mjs`, `tests/guard-symlinked-node-modules.test.mjs`, `tests/gitHooks.test.mjs`, `tests/checkDocLinks.test.mjs`, `tests/reflowDocs.test.mjs`, `tests/cli.test.mjs`), followed by `scripts/check-doc-links.mjs` and `scripts/reflow-docs.mjs --check`.
