# Backlog (`agent-rig`)

Sorted by actionability tier via [`skills/backlog-audit/SKILL.md`](../skills/backlog-audit/SKILL.md).

## Do next

- None currently queued.

## Ready, unblocked

- **Thin static hook delegation shim and `rig hook pre-commit` subcommand:**
  Replace the 70-line shell script in `scripts/git-hooks/pre-commit` with an invariant delegation wrapper that calls `rig hook pre-commit`.
  Move git worktree commit guards, doc-only commit detection, and doc-linter verification inside `bin/rig.mjs`.
  Ensures that updating `agent-rig` centrally does not produce uncommitted modifications in tracked repository hook files.

- **Graceful pre-commit fallback for non-rig contributors and branch-targeted main protection:**
  Update the fallback behavior of `scripts/git-hooks/pre-commit` when `rig` is not installed on the host system.
  Only enforce direct commit rejection on `main` and `master`, allowing external human contributors to commit normally on feature branches in the root checkout without requiring git worktrees.
  Enforces session-per-worktree invariants when `rig` or agent harness guards are active while eliminating friction for non-rig contributors.

- **Selective `rig update` repo management (`--all`, `--repo`, and dirty-tree safety guards):**
  Decouple global harness plugin updates from repository file updates.
  `rig update` by default checks initialized repositories and reports pending updates as a notice rather than silently mutating disk.
  Introduce `rig update --all` and `rig update --repo <path>` with pre-update git cleanliness validation (`git status --porcelain`), skipping and warning on dirty working trees or non-main branches.

- **Multi-environment integration tests for repository updates and non-rig simulation:**
  Add comprehensive integration tests in `tests/cli.test.mjs` simulating clean updates, dirty updates, and external contributor machines.
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
