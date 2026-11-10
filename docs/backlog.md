# Backlog (`agent-rig`)

Sorted by actionability tier via [`skills/backlog-audit/SKILL.md`](../skills/backlog-audit/SKILL.md).

## Do next

- **Decouple `scripts/check-doc-links.mjs` from `bin/rig.mjs` so it is 100% standalone:**
  `scripts/check-doc-links.mjs` currently imports four pure Markdown-block string helpers (`buildDocsIndexBlock`, `extractManagedDocsBlock`, `extractManagedAgentsBlock`, `mergeManagedAgentsFile`) from `../bin/rig.mjs`.
  Unlike `scripts/reflow-docs.mjs` (which imports only Node built-ins), `scripts/check-doc-links.mjs` cannot execute when copied or vendored without `bin/rig.mjs` at `../bin/rig.mjs`, requiring `rig init` to always vendor `bin/rig.mjs` into `.rig/bin/rig.mjs` alongside `.rig/scripts/check-doc-links.mjs`.
  Inlining those pure string helpers into `scripts/check-doc-links.mjs` (and re-exporting or sharing them cleanly with `bin/rig.mjs`) makes both documentation linters zero-dependency, standalone scripts that only import Node built-ins (`node:fs`, `node:child_process`, `node:path`).

- **Add explicit `## Output Format` templates and trigger-rich descriptions to core `SKILL.md` files:**
  [`agents/verifier.md`](../agents/verifier.md) defines a strict `## Required Output Format` Markdown template (`## Verification Report ... VERDICT: PASS | FAIL`), which prevents inconsistent or prose-heavy agent responses.
  However, core skills under `skills/` ([`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md), [`skills/doc-audit/SKILL.md`](../skills/doc-audit/SKILL.md), [`skills/backlog-audit/SKILL.md`](../skills/backlog-audit/SKILL.md), [`skills/wrap-up/SKILL.md`](../skills/wrap-up/SKILL.md), [`skills/rig-onboard/SKILL.md`](../skills/rig-onboard/SKILL.md), [`skills/rig-update/SKILL.md`](../skills/rig-update/SKILL.md), [`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md), and [`skills/secure-credential-handoff/SKILL.md`](../skills/secure-credential-handoff/SKILL.md)) describe their final reporting steps in prose without canonical Markdown output templates, and several frontmatter `description` fields can be sharpened with explicit trigger phrases.
  Adding deterministic `## Output Format` sections and concrete trigger phrases across `skills/` standardizes agent deliverables across sessions and harnesses.

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
  `rig init --self-contained` vendors `scripts/check-doc-links.mjs` and `scripts/reflow-docs.mjs` into `.rig/scripts/`, while `.rig/hooks/pre-commit` (`rig hook pre-commit`) and `rig check-docs` / `rig reflow-docs` execute those `.mjs` scripts to enforce doc graph invariants.
  In non-JavaScript projects (such as Go, Rust, or Python services), this introduces a Node.js runtime requirement exclusively for documentation checking.
  Key trade-offs and open questions:
  whether target repositories should vendor standalone POSIX shell / compiled linters, or delegate `rig check-docs` to the developer's globally installed `rig` CLI;
  how external contributors and headless CI runners in non-Node repositories run doc verification if verification delegates to the host `rig` CLI;
  whether doc link checking and reflow formatting can be implemented in portable POSIX shell / awk or distributed as tiny static utility binaries.

- **Deterministic Gear 2 orchestrator subcommand (`rig dispatch`) invoked transitively from Gear 1:**
  Under [`docs/adr/0002-two-gear-execution-and-worker-subagent.md`](adr/0002-two-gear-execution-and-worker-subagent.md), Gear 2 autonomous wave execution ([`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md)) currently relies on the host harness's prompt-driven subagent tools to enforce the `Triage -> Worktree -> Worker -> Cold Verifier -> Merge Gate` state machine, the five hard stop triggers in [`agents/worker.md`](../agents/worker.md), and read-only Cold Verifier isolation in [`agents/verifier.md`](../agents/verifier.md).
  Moving the Gear 2 state machine into a native `rig` CLI orchestrator subcommand (`bin/rig.mjs`) would allow the interactive Gear 1 session to stay inside the developer's preferred host harness (Antigravity, Claude Code, Cursor, or Codex) and invoke Gear 2 transitively as a deterministic tool.
  `rig` would manage worktree creation, bind Worker `cwd` roots, enforce modified-file-count caps (Stop Trigger #4) and consecutive test-failure limits (Stop Trigger #5) in code rather than prose, run the Cold Verifier in a clean read-only/test-only context without the Worker's transcript, and pause cleanly in `.worktrees/<slug>` whenever a Stop Trigger fires so the developer and main session can seamlessly downshift to Gear 1 in the same conversation before resuming the wave.
  Key trade-offs and open questions:
  whether Worker and Verifier execution turns inside `rig` should wrap headless host harness CLIs (preserving flat-rate subscription billing), call provider APIs directly (BYOK), or embed a lightweight open-source agent loop;
  how paused Worker contexts are suspended and resumed across interactive Gear 1 interventions when an architectural fork (Stop Trigger #2) is resolved in chat;
  whether deterministic state gates should first land as lightweight `rig` subcommands called by existing harness subagents before building a full headless runner loop.

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
