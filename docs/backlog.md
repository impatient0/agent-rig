# Backlog (`agent-rig`)

Sorted by actionability tier via [`skills/backlog-audit/SKILL.md`](../skills/backlog-audit/SKILL.md).

## Do next

- None currently queued.

## Ready, unblocked

- **Narrow `Unmandated-call:` trailer scope with abstract positive and negative examples:**
  Update [`agents/worker.md`](../agents/worker.md), [`agents/verifier.md`](../agents/verifier.md), and [`rules/AGENTS.md`](../rules/AGENTS.md) so `Unmandated-call:` trailers are required only for meaningful behavioral, fallback, or edge-case judgment calls rather than internal helper extraction, local variable naming, or unit test fixture structure.
  Include project-agnostic positive examples (choices that are unmandated calls even if they appear minor, such as silent fallback vs. throwing on an I/O error, picking a default timeout/retry limit, or choosing input precedence) and negative examples (routine coding mechanics that are never unmandated calls, such as extracting a private helper function, naming local identifiers, or structuring test assertions).

- **Exempt tests and documentation link migrations from Worker Scope Explosion threshold:**
  Update [`agents/worker.md`](../agents/worker.md) and [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md) so the $2\times$ Core files cap (minimum floor of 4 files when 1 Core file is listed) counts only production source and configuration files, exempting test files (`tests/`, `*.test.*`, `*.spec.*`) and documentation or link migrations (`docs/`, [`README.md`](../README.md)).

- **Single-pass tip merging, compound `&&` cleanup, and harness-agnostic cleanup in [`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md):**
  Remove the false anti-`&&` command-splitting restriction on worktree cleanup so `git commit && git worktree remove && git branch -d` can run as a single command, remove the Antigravity-specific `BypassSandbox` section so the skill stays 100% harness-agnostic, and document single-pass tip merging when verified branches form a linear stack.

- **Allow `.rig/` commits on `main`/`master` and auto-commit in `rig update`:**
  Update `runPreCommitHook` in `bin/rig.mjs` to permit `.rig/` (and legacy `~~\`scripts/git-hooks/\`~~` deletion) commits directly on `main`/`master` alongside doc-only commits, and update `rig update --repo <dir>` and `rig update --all` to automatically stage and commit repository asset updates on `main`/`master`.

- **Expose `rig`, `node`, and `npm` in `~/.gemini/antigravity/bin` for non-interactive subshells:**
  Update `installForAntigravity` in `bin/rig.mjs` to install the `rig` wrapper and symlink non-system `node` and `npm` binaries into `~/.gemini/antigravity/bin` so non-interactive subshells resolve them natively on `PATH`.

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

- **Custom git wrapper subcommands (`rig pull`, `rig merge`):**
  Rejected to avoid wrapping standard git operations in bespoke CLI abstractions;
  merge orchestration remains in [`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md) using native `git` commands.

## Unranked

- None currently queued.
