# Backlog (`agent-rig`)

Sorted by actionability tier via [`skills/backlog-audit/SKILL.md`](../skills/backlog-audit/SKILL.md).

## Do next

- None currently queued.

## Ready, unblocked

- None currently queued.

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
