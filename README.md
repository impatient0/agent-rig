# agent-rig

Subagent-first, platform-agnostic workflow rig for agentic software engineering:
multi-protocol `PreToolUse` guards, a **Tech Lead → Isolated Worker → Cold Verifier** dispatch pipeline, git worktree isolation locks, and documentation graph linters.
Extracted from production agentic sessions after measuring where human time and agent mistakes actually went — see [`docs/field-notes.md`](docs/field-notes.md) for the failure modes and post-mortems behind each mechanism.

## Design Stance: Audience of One

This repository is built for its author first and published in case its mechanisms are useful to you.
If making a rule more universally appealing ever conflicts with keeping the author's own workflow sharp — such as requiring a cold read-only Verifier subagent in [`skills/dispatch/SKILL.md`](skills/dispatch/SKILL.md) or parking the root git checkout on a detached `HEAD` — universal appeal loses every time.
Nothing here is a speculative prompt template:
every hook, skill, and check was added only after a simpler written rule failed in a real session.
Where a default convention is too heavy for a small project, the CLI provides opt-out flags (`rig init --no-worktrees`) rather than watering down the defaults.

---

## Architecture: Global Rig vs. Per-Project State

`agent-rig` separates **how you work across every project** from **what a specific project is about**:

1. **Global Layer (`rig install`):**
   Installs your universal engineering rules ([`rules/AGENTS.md`](rules/AGENTS.md), [`rules/ui-change-gate.md`](rules/ui-change-gate.md)), all 6 skills (`skills/`), the cold Verifier subagent definition ([`agents/verifier.md`](agents/verifier.md)), and the multi-protocol `PreToolUse` guards (`hooks/`) into your harnesses' global configuration directories (`~/.gemini/config/`, `~/.claude/`, `~/.codex/`, `~/.cursor/`).
   Because these are linked to your `agent-rig` clone, editing an existing skill, rule, or hook inside `agent-rig` takes effect across every project immediately;
   running `rig update` links any newly added skills or agents without re-prompting.
2. **Per-Project Layer (`rig init`):**
   Touches a project repository as lightly as possible:
   sets up git worktree commit/merge hooks (`scripts/git-hooks/`), parks the root checkout on a detached `HEAD` at `main`, and creates a minimal 7-line `AGENTS.md` project-context stub alongside [`docs/backlog.md`](docs/backlog.md) and [`docs/adr/0001-record-architecture-decisions.md`](docs/adr/0001-record-architecture-decisions.md).

---

## Quick Start

### 1. Install Globally Into Your Harnesses (`rig install`)

Clone the repository, link the `rig` CLI, and run `rig install` to scan `$HOME` for installed harnesses (`~/.gemini` for Antigravity, `~/.claude` for Claude Code, `~/.codex` for Codex CLI, `~/.cursor` for Cursor) and interactively select where to install the rig:

```bash
git clone https://github.com/impatient0/agent-rig.git
cd agent-rig
npm link
rig install
```

Or run `rig install` non-interactively:

```bash
# Install into specific harnesses:
rig install --harnesses antigravity,claude
# Or install into all detected harnesses:
rig install --detected
```

What `rig install` configures:
- **CLI Binary (`~/.local/bin/rig`):**
  Symlinks `~/.local/bin/rig` to `bin/rig.mjs` so `rig` remains on your `PATH` even if you switch Node versions in `nvm` later.
- **Antigravity (`~/.gemini/config/`):**
  Registers `agent-rig` in `~/.gemini/config/plugins.json` and links `~/.gemini/config/plugins/agent-rig`, activating [`rules/AGENTS.md`](rules/AGENTS.md), all 6 skills under `skills/`, and `hooks.json` across every workspace.
- **Claude Code (`~/.claude/`):**
  Symlinks `skills/` into `~/.claude/skills/`, [`agents/verifier.md`](agents/verifier.md) into `~/.claude/agents/verifier.md`, `rules/` into `~/.claude/rules/`, and `hooks/` into `~/.claude/hooks/`, and non-destructively merges `PreToolUse` hooks into `~/.claude/settings.json`.
  (Alternatively, inside Claude Code you can run `/plugin marketplace add impatient0/agent-rig` and `/plugin install agent-rig@agent-rig`.)
- **Codex CLI (`~/.codex/`) & Cursor (`~/.cursor/`):**
  Symlinks the portable skills and global `AGENTS.md` rules.

To sync newly added skills, subagents, or hook entries into your previously selected harnesses after pulling changes in `agent-rig`:

```bash
rig update
```

### 2. Initialize a Project Repository (`rig init`)

When starting or onboarding a repository that should enforce worktree commit locks and track its own backlog and ADRs:

```bash
rig init /path/to/your-project
```

What `rig init` does by default:
1. Copies `scripts/git-hooks/pre-commit` and `scripts/git-hooks/pre-merge-commit` and configures `git config core.hooksPath scripts/git-hooks`.
2. Creates a minimal project-context `AGENTS.md` (`templates/AGENTS.md`), [`docs/backlog.md`](docs/backlog.md), and [`docs/adr/0001-record-architecture-decisions.md`](docs/adr/0001-record-architecture-decisions.md) if they do not exist yet.
3. Parks the root checkout on a detached `HEAD` at `main` if the working tree is clean (or run `rig detach` after committing the initial files).

Flags for `rig init`:
- `--self-contained` — Also copy `skills/`, `agents/`, `rules/`, `hooks/`, `scripts/check-doc-links.mjs`, and `scripts/reflow-docs.mjs` directly into the repository (useful for team repos or CI).
- `--no-worktrees` — Skip git worktree hooks and detached-`HEAD` setup for single-checkout repos.
- `--ui` — Also copy `templates/docs/design/mockup-scaffold.html`.
- `--force` — Overwrite existing files.

### 3. Run Documentation Linters Anywhere (`rig check-docs` & `rig reflow-docs`)

Verify link graph integrity or normalize Markdown files to one sentence per line in any repository without copying scripts into that project:

```bash
rig check-docs /path/to/your-project
rig reflow-docs /path/to/your-project --check
```

---

## Writing a Per-Project `AGENTS.md`

Because your universal workflow rules ([`rules/AGENTS.md`](rules/AGENTS.md)) are already loaded globally via `rig install`, a project's local `AGENTS.md` should **never** repeat generic workflow instructions (worktree rules, commit trailers, doc formatting).
Keep each project's `AGENTS.md` focused strictly on project-specific facts a cold session cannot infer quickly:

1. **One-paragraph purpose and stack summary.**
2. **Exact build, test, and verification commands** (`npm test`, `cargo test`, etc.).
3. **Non-obvious domain invariants or footguns** specific to that codebase.
4. **Entry-point links** to [`docs/backlog.md`](docs/backlog.md) and [`docs/adr/0001-record-architecture-decisions.md`](docs/adr/0001-record-architecture-decisions.md) so `rig check-docs` can traverse the project's documentation graph.

---

## Core Workflows

### 1. Subagent-First Task Dispatch (`dispatch`)

[`skills/dispatch/SKILL.md`](skills/dispatch/SKILL.md) structures multi-task and backlog execution around a 2-layer **Tech Lead → Isolated Worker → Cold Verifier** topology:

1. **Triage (Bucket 1 vs. Bucket 2):**
   The main session (Tech Lead) grounds candidate tasks against the codebase and splits them into **Bucket 1 (Dispatch Now)** (passes Gate A non-UI and Gate B spec clarity) and **Bucket 2 (Ask User First)**.
2. **Parallel Isolated Workers:**
   Bucket 1 tasks (up to 3 per wave) are dispatched immediately to background Worker subagents in isolated git worktrees under five hard stop triggers and the `Unmandated-call:` commit trailer contract, while the Tech Lead asks you the concrete questions for Bucket 2.
3. **Cold Verifier (`Executor != Verifier`):**
   When a Worker finishes, the Tech Lead spawns a fresh, read-only Verifier subagent governed by [`agents/verifier.md`](agents/verifier.md) that sees **only** the task brief, `git diff <base>..HEAD`, `Unmandated-call:` trailers, and test output—never the Worker's chain of thought.

### 2. Session-Per-Worktree Isolation

1. **Root checkout stays parked on a detached `HEAD` at `main`** (`rig detach`) and is never edited directly.
2. **Every session or Worker subagent operates in a linked git worktree** on a `<type>/<slug>` branch.
   `hooks/guard-main-checkout-edits.mjs` blocks direct file edits in the root checkout, and `scripts/git-hooks/pre-commit` blocks root-checkout commits made via shell commands.
3. **Merging uses `main` as a mutex lock** via [`skills/merge-to-main/SKILL.md`](skills/merge-to-main/SKILL.md):
   the worktree runs `git switch main`, tests the uncommitted merge, commits, and immediately runs `git switch --detach main`.

---

## What's Inside

### Skills (`skills/`) & Subagents (`agents/`)
- [`dispatch`](skills/dispatch/SKILL.md) — Triage → Isolated Worker → Cold Verifier pipeline.
- [`agents/verifier.md`](agents/verifier.md) — Rigid, read-only cold Verifier subagent prompt and `VERDICT: PASS | FAIL` checklist.
- [`wrap-up`](skills/wrap-up/SKILL.md) — End-of-session checkpoint:
  verifies git/worktree cleanliness and test gates, routes undocumented decisions to ADRs or [`docs/backlog.md`](docs/backlog.md), and checks cold-session reachability.
- [`backlog-audit`](skills/backlog-audit/SKILL.md) — Sorts `Unranked` items in [`docs/backlog.md`](docs/backlog.md) into six actionability tiers after checking existing ADRs for prior rejections.
- [`doc-audit`](skills/doc-audit/SKILL.md) — Audits documentation for mixed lifecycles (stable decisions vs. chronological slice logs), duplicate prose, and stale code claims.
- [`merge-to-main`](skills/merge-to-main/SKILL.md) — Safe worktree-to-`main` merge procedure.
- [`secure-credential-handoff`](skills/secure-credential-handoff/SKILL.md) — Mode-`0600` env-file pattern so secrets never enter the chat transcript.

### Multi-Protocol Mechanical Guards (`hooks/` & `scripts/git-hooks/`)
- `hooks/lib/hook-io.mjs` — Documented `PreToolUse` JSON schema adapter supporting Antigravity (`toolCall.args` → `{ decision, reason }`), Claude Code (`tool_input` → `{ hookSpecificOutput }`), generic JSON runners, and explicit `--harness=<name>` flags.
- `hooks/guard-remote-mutation.mjs` — Prompts (`ask`) before commands that mutate remote or shared state (`ssh`, `scp`, `rsync`, `crontab`, `docker -H`, `git push` to `main`, mutating `gh` calls).
- `hooks/guard-main-checkout-edits.mjs` — Refuses (`deny`) file edits in the root checkout.
- `hooks/guard-symlinked-node-modules.mjs` — Refuses (`deny`) `npm`, `pnpm`, `yarn`, and `bun` installs when `node_modules` is a shared symlink (including `cd .worktrees/<slug> && npm install` chains).
- `scripts/git-hooks/pre-commit` & `scripts/git-hooks/pre-merge-commit` — Refuse commits or merges in the root checkout and direct commits on `main`.

### Documentation Graph Linters (`scripts/`)
- `scripts/check-doc-links.mjs` — Enforces resolved relative links and `#fragment` headings, bans wiki-style refs/globs/bare backticked doc paths, verifies reachability from entry points, checks cited repo paths on disk, and enforces ADR byte budgets.
- `scripts/reflow-docs.mjs` — Normalizes Markdown files to one sentence per line.

---

## Testing

```bash
npm test
```

`npm test` runs the full `node:test` suite (`tests/hookIo.test.mjs`, `tests/guard-remote-mutation.test.mjs`, `tests/guard-main-checkout-edits.test.mjs`, `tests/guard-symlinked-node-modules.test.mjs`, `tests/gitHooks.test.mjs`, `tests/checkDocLinks.test.mjs`, `tests/reflowDocs.test.mjs`, `tests/cli.test.mjs`), followed by `scripts/check-doc-links.mjs` and `scripts/reflow-docs.mjs --check`.
