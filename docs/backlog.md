# Backlog (`agent-rig`)

Sorted by actionability tier via [`skills/backlog-audit/SKILL.md`](../skills/backlog-audit/SKILL.md).

## Do next

- **Encapsulate repository mechanics in `.rig/` with invariant hook shim and `rig hook pre-commit`:**
  Relocate git hooks from `scripts/git-hooks/` to `.rig/hooks/` and point `core.hooksPath` to `.rig/hooks`.
  Replace the tracked hook script with an invariant 5-line delegation wrapper calling `rig hook pre-commit`.
  Implement `rig hook pre-commit` inside `bin/rig.mjs` to execute worktree checks, doc-only commit gates, and doc linters centrally.
  Provide fallback in the hook wrapper for environments without `rig`, permitting standard feature branch commits in the root checkout while protecting `main` and `master`.
  In `--self-contained` mode, route vendored skills, agents, and rules into detected harness dot-directories (`.claude/`, `.gemini/`), failing fast if no harness is detected or specified.
  Automatically migrate legacy repositories from `scripts/git-hooks/` to `.rig/hooks/` during update.

## Ready, unblocked

- **Idempotent `rig attach`, cloned repo onboarding, and hook auto-attach:**
  Introduce a dedicated `rig attach [<dir>]` command that configures `core.hooksPath .rig/hooks`, attaches `main` in the root checkout, and registers the repo in `state.initializedRepos` without spawning scaffolding worktrees.
  Update `rig init` to detect already-rigged repositories (presence of `.rig/` or `AGENTS.md`) and automatically delegate to `rig attach`.
  Add zero-prompt auto-attach in `hooks/guard-main-checkout-edits.mjs` so the first agent tool execution in a fresh clone configures hooks silently.

- **Selective `rig update` repo management (`--all`, `--repo`, and dirty-tree safety guards):**
  Decouple global harness plugin updates from repository file updates in `bin/rig.mjs`.
  `rig update` by default checks initialized repositories and reports pending updates as a notice rather than silently mutating disk.
  Introduce `rig update --all` and `rig update --repo <path>` with pre-update git cleanliness validation (`git status --porcelain`), skipping and warning on dirty working trees or non-main branches.

- **Hands-free agent tooling: CLI awareness in [`rules/AGENTS.md`](../rules/AGENTS.md) and `rig-update` skill:**
  Update [`rules/AGENTS.md`](../rules/AGENTS.md) to catalog `rig` CLI entry points (`rig status`, `rig check-docs`, `rig reflow-docs`, `rig attach`, `rig update`) so agents discover and run them natively.
  Create a dedicated `rig-update` skill specifying an autonomous worktree-isolated update procedure (`chore/rig-update`), running test and doc gates, and merging via [`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md).

- **Multi-environment integration tests for repository updates and non-rig simulation:**
  Add comprehensive integration tests in `tests/cli.test.mjs` validating `.rig/` layout, `rig attach`, clean/dirty updates, and non-rig machine behavior.
  Simulate non-rig machines by spawning git and hook processes with sanitized `PATH` (excluding rig binaries) and an isolated empty `HOME`.
  Verify that clean repositories update shims cleanly, dirty repositories reject updates with warnings, and non-rig environments permit feature branch commits while protecting `main`.

## Gated on an in-flight milestone

- None currently queued.

## Needs a decision

- **Standalone compiled CLI binary vs. Node runtime dependency:**
  `agent-rig` currently executes via Node.js scripts (`bin/rig.mjs`, harness hooks, and repository scripts) driven by shebangs and runtime wrappers.
  In environments where Node is managed in user-space versions (such as NVM or fnm) without global symlinks on system `PATH`, non-interactive subshells and harness runners fail to resolve `node`.
  Compiling `rig` into a standalone, single-executable binary (in Go, Rust, or via Node SEA / `bun build --compile`) would eliminate host runtime dependencies and shebang resolution fragility.
  Key trade-offs and open questions:
  distribution complexity requires cross-compilation CI pipelines and platform release archives instead of the current lightweight `git pull && rig update` model;
  development velocity favors script-based hooks that allow immediate local edits without compilation steps;
  the threshold for adopting this is whether multi-machine environment heterogeneity or external distribution warrants maintaining a release matrix.

- **Decoupling repository documentation linters from Node in non-Node projects:**
  `rig init` copies `scripts/check-doc-links.mjs` and `scripts/reflow-docs.mjs` into target repositories so local git hooks and test gates enforce doc graph invariants.
  In non-JavaScript projects (such as Go, Rust, or Python services), this introduces a Node.js runtime requirement exclusively for documentation checking.
  Key trade-offs and open questions:
  whether target repositories should vendor standalone POSIX shell / compiled linters, or delegate `rig check-docs` to the developer's globally installed `rig` CLI;
  how external contributors and headless CI runners in non-Node repositories run doc verification if verification delegates to the host `rig` CLI;
  whether doc link checking and reflow formatting can be implemented in portable POSIX shell / awk or distributed as tiny static utility binaries.

## Waiting on an external trigger

- **Optional Playwright `browser-driver` plugin/skill:**
  Re-introduce the headless Playwright REPL skill only if Antigravity's native browser tools prove insufficient for deterministic geometry verification in real projects.

## Not sanctioned

- **Single-agent fallback branches inside [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md):**
  Deliberately omitted so subagent-capable harnesses have zero prompt escape hatches to skip the cold Verifier subagent.

## Unranked

- None currently queued.
