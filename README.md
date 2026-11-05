# agent-rig

Subagent-first, platform-agnostic workflow rig for agentic software engineering:
multi-protocol `PreToolUse` guards, a **Tech Lead → Isolated Worker → Cold Verifier** dispatch pipeline, git worktree isolation locks, and documentation graph linters.
Extracted from production agentic sessions after measuring where human time and agent mistakes actually went — see [`docs/field-notes.md`](docs/field-notes.md) for the failure modes and post-mortems behind each mechanism.

## Design Stance: Audience of One

This repository is built for its author first and published in case its mechanisms are useful to you.
If making a rule more universally appealing ever conflicts with keeping the author's own workflow sharp — such as requiring a cold read-only Verifier subagent in [`skills/dispatch/SKILL.md`](skills/dispatch/SKILL.md) or restricting the root git checkout to merge commits only — universal appeal loses every time.
Nothing here is a speculative prompt template:
every hook, skill, and check was added only after a simpler written rule failed in a real session.
Where a default convention is too heavy for a small project, the CLI provides opt-out flags (`rig init --no-worktrees`) rather than watering down the defaults.

---

## Architecture: Global Rig vs. Per-Project State

`agent-rig` separates **how you work across every project** from **what a specific project is about**:

1. **Global Layer (`rig install`):**
   Installs your universal engineering rules ([`rules/AGENTS.md`](rules/AGENTS.md), [`rules/ui-change-gate.md`](rules/ui-change-gate.md), [`rules/contract-change-gate.md`](rules/contract-change-gate.md)), all 8 skills (`skills/`), the Worker and Verifier subagent definitions ([`agents/worker.md`](agents/worker.md), [`agents/verifier.md`](agents/verifier.md)), and the multi-protocol `PreToolUse` guards (`hooks/`) into your harnesses' global configuration directories (`~/.gemini/config/`, `~/.claude/`, `~/.codex/`, `~/.cursor/`).
   Prompts, skills, and agent definitions are statically hydrated with your active model profile from `.rig.local.json` (seeded from [`templates/rig-config.default.json`](templates/rig-config.default.json) and validated by [`templates/rig-config.schema.json`](templates/rig-config.schema.json) using the model catalog [`templates/models.json`](templates/models.json)).
   Running `rig update` or `rig profile use` re-hydrates your harnesses immediately with any changes.
2. **Per-Project Layer (`rig init`):**
   Touches a project repository as lightly as possible:
   sets up git worktree commit hooks (`.rig/hooks/`), leaves the root checkout attached to `main` as a merge-only trunk, and creates a minimal 7-line `AGENTS.md` project-context stub alongside [`docs/backlog.md`](docs/backlog.md) and [`docs/adr/0001-record-architecture-decisions.md`](docs/adr/0001-record-architecture-decisions.md).

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
  Installs an executable shell wrapper at `~/.local/bin/rig` with resolved Node runtime execution and fail-safe diagnostics advising `rig update` if Node is relocated.
- **Antigravity (`~/.gemini/config/`):**
  Registers `agent-rig` in `~/.gemini/config/plugins.json` and stages a hydrated plugin in `~/.gemini/config/plugins/agent-rig`, activating [`rules/AGENTS.md`](rules/AGENTS.md), all 8 skills under `skills/`, and `hooks.json` with dynamic Node runtime resolution across every workspace with symlinked `hooks/`.
- **Claude Code (`~/.claude/`):**
  Installs hydrated `skills/` into `~/.claude/skills/`, subagents ([`agents/worker.md`](agents/worker.md), [`agents/verifier.md`](agents/verifier.md)) into `~/.claude/agents/`, and `rules/` into `~/.claude/rules/`, symlinks `hooks/` into `~/.claude/hooks/`, and non-destructively merges dynamically resolved `PreToolUse` hooks into `~/.claude/settings.json`.
  (Alternatively, inside Claude Code you can run `/plugin marketplace add impatient0/agent-rig` and `/plugin install agent-rig@agent-rig`.)
- **Codex CLI (`~/.codex/`) & Cursor (`~/.cursor/`):**
  Installs hydrated skills and global `AGENTS.md` rules.

To pull updates in `agent-rig`, standard `git pull` works directly in the root checkout;
run `rig update` afterwards to sync newly added skills, subagents, or hook entries into your previously selected harnesses:

```bash
git pull
rig update
```

By default, `rig update` updates global harness files and checks initialized repositories, reporting pending repository updates as a notice rather than mutating disk.
To update repositories explicitly with pre-update git cleanliness validation:

```bash
# Update a specific initialized repository:
rig update --repo /path/to/your-project

# Or update all initialized repositories:
rig update --all
```

### 2. Configure Execution Tiers & Model Profiles (`rig profile`)

`agent-rig` organizes work across four canonical execution tiers:
- **`architect`** — Main session / Tech Lead (triage, backlog/doc auditing, repo onboarding, session wrap-up, ADR authoring, and handling Worker stop triggers).
- **`worker`** — Isolated implementation subagents in [`agents/worker.md`](agents/worker.md) under [`skills/dispatch/SKILL.md`](skills/dispatch/SKILL.md).
- **`verifier`** — Cold audit subagent in [`agents/verifier.md`](agents/verifier.md).
- **`utility`** — Fast mechanical procedures ([`skills/merge-to-main/SKILL.md`](skills/merge-to-main/SKILL.md), [`skills/rig-update/SKILL.md`](skills/rig-update/SKILL.md), [`skills/secure-credential-handoff/SKILL.md`](skills/secure-credential-handoff/SKILL.md)) and targeted read-only research subagents.

View configured profiles and active assignments:

```bash
rig profile
```

Switch active profiles per harness (re-hydrates installed harness files immediately):

```bash
rig profile use antigravity-pro
rig profile use claude-pro
```

Customize a specific role's model, subagent selector, or reasoning effort in `.rig.local.json`:

```bash
rig profile set worker claude-opus-5-5 --effort high
rig profile set worker claude-opus-5-5 --subagent-model opus
```

Inspect resolved model parameters for any role:

```bash
rig model resolve worker
rig model resolve verifier --harness claude --json
```

#### Extending Profiles and Models (`.rig.local.json`)

Model definitions and default subagent selectors are cataloged in [`templates/models.json`](templates/models.json) and validated by [`templates/rig-config.schema.json`](templates/rig-config.schema.json).
You can define custom models and custom profiles in `.rig.local.json` without modifying `agent-rig` code:

```json
{
  "models": {
    "my-custom-model": {
      "subagentSelector": {
        "antigravity": "flash",
        "claude": "sonnet"
      }
    }
  },
  "profiles": {
    "my-custom-profile": {
      "harness": "antigravity",
      "roles": {
        "architect": { "model": "gemini-4-argon", "effort": "high" },
        "worker": { "model": "my-custom-model", "effort": "medium" },
        "verifier": { "model": "gemini-3-8-flash", "effort": "medium" },
        "utility": { "model": "gemini-3-8-flash", "effort": "low" }
      }
    }
  }
}
```

### 3. Initialize a Project Repository (`rig init`)

When starting or onboarding a repository that should enforce worktree commit locks and track its own backlog and ADRs:

```bash
rig init /path/to/your-project
```

What `rig init` does by default:
1. Copies `.rig/hooks/pre-commit` and configures `git config core.hooksPath .rig/hooks`.
2. Creates a minimal project-context `AGENTS.md` (`templates/AGENTS.md`), [`docs/backlog.md`](docs/backlog.md), and [`docs/adr/0001-record-architecture-decisions.md`](docs/adr/0001-record-architecture-decisions.md) if they do not exist yet.
3. Leaves the root checkout attached to `main` as a merge-only trunk.

Flags for `rig init`:
- `--self-contained` — Also copy `skills/`, `agents/`, `rules/`, `hooks/`, `scripts/check-doc-links.mjs`, and `scripts/reflow-docs.mjs` directly into the repository (useful for team repos or CI).
- `--no-worktrees` — Skip git worktree hooks for single-checkout repos.
- `--ui` — Also copy `templates/docs/design/mockup-scaffold.html`.
- `--force` — Overwrite existing files.

### 4. Attach an Existing or Cloned Repository (`rig attach`)

When working in a cloned repository that is already rigged under `agent-rig` conventions, attach the repository without creating scaffolding worktrees:

```bash
rig attach /path/to/your-project
```

What `rig attach` does:
1. Configures `git config core.hooksPath .rig/hooks` unless a third-party hook manager is detected.
2. Ensures `.rig/hooks/pre-commit` exists in the main checkout when `AGENTS.md` or `.rig/` is present.
3. Attaches `main` or `master` in the root checkout.
4. Registers the root checkout in global rig state (`~/.config/agent-rig/state.json`).

Note that `rig init` automatically detects already-rigged repositories and delegates to `rig attach`.
In addition, `hooks/guard-main-checkout-edits.mjs` automatically configures `core.hooksPath` on the first agent edit in a fresh clone.

### 5. Run Documentation Linters Anywhere (`rig check-docs` & `rig reflow-docs`)

Verify link graph integrity or normalize Markdown files to one sentence per line in any repository without copying scripts into that project:

```bash
rig check-docs /path/to/your-project
rig reflow-docs /path/to/your-project --check
```

### 6. Inspect Repository Status (`rig status`)

Inspect an initialized project repository or worktree at a glance to check active hooks, skills, and documentation files:

```bash
rig status /path/to/your-project
```

### 7. Eject a Repository (`rig eject`)

When you want to remove `agent-rig` mechanical infrastructure from a repository:

```bash
rig eject /path/to/your-project
```

What `rig eject` does:
1. Unsets `git config core.hooksPath` in the repository if it points to `.rig/hooks` or legacy git hooks.
2. Deletes `.rig/` and legacy git hooks from the repository.
3. Removes the repository from global rig state (`~/.config/agent-rig/state.json`).
4. Preserves `AGENTS.md` and `docs/` as durable documentation while leaving the git repository in a standard un-rigged state.

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
   When a Worker finishes, the Tech Lead spawns a fresh Verifier subagent governed by [`agents/verifier.md`](agents/verifier.md) with command execution enabled to run tests live in the worktree, seeing only the task brief, commit trailers, and diff—never the Worker's chain of thought.

### 2. Session-Per-Worktree Isolation

1. **Root checkout stays attached to `main` as a merge-only trunk** and is never edited directly.
2. **Every session or Worker subagent operates in a linked git worktree** on a `<type>/<slug>` branch.
   `hooks/guard-main-checkout-edits.mjs` blocks direct file edits in the root checkout, and `.rig/hooks/pre-commit` blocks root-checkout commits made via shell commands.
3. **Shared dependency caching via symlinked `node_modules`:**
   If the repository has a `node_modules` directory at the root, symlink it into the worktree (`ln -s ../../node_modules node_modules`) unless the branch modifies dependencies (`hooks/guard-symlinked-node-modules.mjs` blocks package installs against a symlinked directory).
4. **Merging happens directly in the root checkout** via [`skills/merge-to-main/SKILL.md`](skills/merge-to-main/SKILL.md):
   the root checkout runs `git merge --no-commit --no-ff`, verifies the uncommitted merge state, commits on `main`, and removes the worktree.

---

## What's Inside

### Universal Engineering Rules (`rules/`)
- [`rules/AGENTS.md`](rules/AGENTS.md) — Universal agentic engineering rules (investigation first, session-per-worktree isolation, triage & verification, commit trailers, documentation graph invariants).
- [`rules/ui-change-gate.md`](rules/ui-change-gate.md) — Human-in-the-loop UI change gate (Gate A in `dispatch` triage: visual or interactive changes require a user-approved mockup before implementation).
- [`rules/contract-change-gate.md`](rules/contract-change-gate.md) — Human-in-the-loop domain & schema contract gate (Gate A in `dispatch` triage: public interfaces, persistence schemas, wire protocols, and state transitions require explicit prior human approval).

### Skills (`skills/`) & Subagents (`agents/`)
- [`dispatch`](skills/dispatch/SKILL.md) — Triage → Isolated Worker → Cold Verifier pipeline.
- [`agents/worker.md`](agents/worker.md) — Isolated Worker subagent prompt, line-level epistemic hygiene, and five hard stop triggers.
- [`agents/verifier.md`](agents/verifier.md) — Cold Verifier subagent prompt and `VERDICT: PASS | FAIL` checklist (runs tests live, strictly read-only for code).
- [`wrap-up`](skills/wrap-up/SKILL.md) — End-of-session checkpoint:
  verifies git/worktree cleanliness and test gates, routes undocumented decisions to ADRs or [`docs/backlog.md`](docs/backlog.md), and checks cold-session reachability.
- [`backlog-audit`](skills/backlog-audit/SKILL.md) — Sorts `Unranked` items in [`docs/backlog.md`](docs/backlog.md) into six actionability tiers after checking existing ADRs for prior rejections.
- [`doc-audit`](skills/doc-audit/SKILL.md) — Audits documentation for mixed lifecycles (stable decisions vs. chronological slice logs), duplicate prose, and stale code claims.
- [`rig-onboard`](skills/rig-onboard/SKILL.md) — Onboards an existing repository with legacy agent files (CLAUDE.md), decision logs, or backlog into agent-rig conventions without dual-convention state.
- [`rig-update`](skills/rig-update/SKILL.md) — Autonomous worktree-isolated repository asset update and verification procedure.
- [`merge-to-main`](skills/merge-to-main/SKILL.md) — Safe worktree-to-`main` merge procedure.
- [`secure-credential-handoff`](skills/secure-credential-handoff/SKILL.md) — Mode-`0600` env-file pattern so secrets never enter the chat transcript.

### Multi-Protocol Mechanical Guards (`hooks/` & `.rig/hooks/`)
- `hooks/lib/hook-io.mjs` — Documented `PreToolUse` JSON schema adapter supporting Antigravity (`toolCall.args` → `{ decision, reason }`), Claude Code (`tool_input` → `{ hookSpecificOutput }`), generic JSON runners, and explicit `--harness=<name>` flags.
- `hooks/guard-remote-mutation.mjs` — Prompts (`ask`) before commands that mutate remote or shared state (`ssh`, `scp`, `rsync`, `crontab`, `docker -H`, `git push` to `main`, mutating `gh` calls).
- `hooks/guard-main-checkout-edits.mjs` — Refuses (`deny`) file edits in the root checkout.
- `hooks/guard-symlinked-node-modules.mjs` — Refuses (`deny`) `npm`, `pnpm`, `yarn`, and `bun` installs when `node_modules` is a shared symlink (including `cd .worktrees/<slug> && npm install` chains).
- `.rig/hooks/pre-commit` — Refuses direct non-merge commits in the root checkout and direct commits on `main`.

### Documentation Graph Linters (`scripts/`)
- `scripts/check-doc-links.mjs` — Enforces resolved relative links and `#fragment` headings, bans wiki-style refs/globs/bare backticked doc paths, verifies reachability from entry points, checks cited repo paths on disk, and enforces ADR byte budgets.
- `scripts/reflow-docs.mjs` — Normalizes Markdown files to one sentence per line.

---

## Testing

```bash
npm test
```

`npm test` runs the full `node:test` suite (`tests/hookIo.test.mjs`, `tests/guard-remote-mutation.test.mjs`, `tests/guard-main-checkout-edits.test.mjs`, `tests/guard-symlinked-node-modules.test.mjs`, `tests/gitHooks.test.mjs`, `tests/checkDocLinks.test.mjs`, `tests/reflowDocs.test.mjs`, `tests/cli.test.mjs`), followed by `scripts/check-doc-links.mjs` and `scripts/reflow-docs.mjs --check`.
