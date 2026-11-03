# Backlog (`agent-rig`)

Sorted by actionability tier via [`skills/backlog-audit/SKILL.md`](../skills/backlog-audit/SKILL.md).

## Do next

- None currently queued.

## Ready, unblocked

- **Fix multi-harness profile resolution and hydrate global install links in CLI:**
  In `bin/rig.mjs`, `initRepo` (when `--self-contained` is set) and `updateRepo` hardcode Claude profile resolution (`resolveProfile('claude', ...)`), injecting Claude model selectors into non-Claude harnesses.
  Both commands should accept `--harness` or resolve profiles against the target repository's configured harness.
  In addition, `installForCodex` hydrates [`rules/AGENTS.md`](../rules/AGENTS.md) directly into `~/.codex/AGENTS.md`, which breaks relative links to skills (`../skills/...`), while globally installed skills reference repo-local `../../docs/backlog.md`.
  Installation routines should rewrite relative inter-doc links to match each target harness's installed layout and distinguish repo-relative paths in global skill prompts.

- **Preserve existing git hook managers in rig init and add runtime fallbacks to hook wrappers:**
  `rig init` in `bin/rig.mjs` unconditionally overrides `git config core.hooksPath scripts/git-hooks`, silently disabling pre-existing Husky, Lefthook, or Python pre-commit configurations in existing codebases.
  Initialization should check existing hook configurations, warn if another hook runner is present, and offer chaining guidance.
  Furthermore, `buildHookCommand` and `buildRigWrapperScript` bake absolute Node paths that break if the active Node version is uninstalled after an NVM or fnm upgrade.
  Hook wrappers should fall back to probing standard version manager shims and current aliases before failing.

- **Standardize task brief storage, wrap-up doc workflow, and double-backtick doc linter parsing:**
  [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md) instructs writing task briefs to the session artifact directory, which is only supported out-of-repo by Antigravity and leads to blocked root edits or untracked worktree files in Claude Code and Codex.
  Brief paths should be standardized to a deterministic, gitignored location such as `<git-common-dir>/rig-briefs/<slug>.md`.
  In [`skills/wrap-up/SKILL.md`](../skills/wrap-up/SKILL.md), documentation updates should be explicitly sequenced inside the active worktree prior to merging into `main` so the main checkout edit guard is not triggered.
  In `scripts/check-doc-links.mjs`, the inline code-span regex should match variable backtick runs (`/(`+)\s*([\s\S]*?)\s*\1/g`) so double-backtick inline spans are parsed without error.

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
