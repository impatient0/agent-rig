# Backlog (`agent-rig`)

<!-- last-doc-audit: 2026-11-18 commit=64682da -->
<!-- Authoring rule: Check docs/adr/ for prior rejections and verify against live code (using a read-only utility research subagent if outside current session context) before inserting any item directly into its actionability tier below. -->

## Do next
<!-- High-leverage, unblocked, spec-complete items ready for immediate execution or dispatch (Open Decisions = 0, identified Core files, and verification command). -->

- None currently queued.

## Ready, unblocked
<!-- Clear scope, identified Core files, and unambiguous acceptance criteria (Open Decisions = 0); can be picked up by a Worker subagent at any time without human input. -->

- **Isolate `HOME` in hermetic `tests/cli.test.mjs` profile and repository initialization tests:**
  `resolveProfile` and `initRepo` assertions in `tests/cli.test.mjs` fall back to `os.homedir()` when `homeDir` is omitted, reading the host's real `~/.config/agent-rig/config.json` (e.g., `antigravity-ultra`) or failing with `EROFS` inside sandboxed shells where `~/.config/agent-rig` is read-only.
  Pass explicit temporary `homeDir` directories in those unit tests (or isolate `HOME` in the test runner) so `npm test` passes identically regardless of host `~/.config/agent-rig` state.
  Core files: `tests/cli.test.mjs`.
  Verification: `npm test`.

- **Re-merge `.claude/settings.json` hook manifests during `rig update --repo` in self-contained Claude repositories:**
  In `bin/rig.mjs`, `updateRepo` copies newly added hook scripts (such as `hooks/guard-secret-exposure.mjs`) into `.claude/hooks/` for `--self-contained` Claude repositories, but does not invoke `mergeClaudeSettings` against `.claude/settings.json` (nor flag missing hook entries in `checkRepoPendingUpdates`).
  Update `checkRepoPendingUpdates` and `updateRepo` in `bin/rig.mjs` to non-destructively merge `templates/claude/settings.worktree.json` or `templates/claude/settings.minimal.json` into `.claude/settings.json` so existing self-contained Claude repositories receive newly added `PreToolUse` matchers on `rig update --repo`.
  Core files: `bin/rig.mjs`, `templates/claude/settings.worktree.json`, `templates/claude/settings.minimal.json`.
  Verification: `npm test`.

- **Unify wrapper-flag skipping (`sudo -u`, `env -i`, `command -p`) in `hooks/lib/shell-parser.mjs` (`stripWrappers`):**
  `stripWrappers` in `hooks/lib/shell-parser.mjs` strips bare wrapper binaries (`sudo`, `env`, `nohup`, `time`, `command`, `exec`) and `VAR=val` assignments, but stops when a wrapper carries flags (such as `sudo -u root`, `env -i`, or `command -p`), whereas `hooks/guard-secret-exposure.mjs` unwraps `env` flags locally.
  Extend `stripWrappers` in `hooks/lib/shell-parser.mjs` to skip known wrapper flags and option arguments so all shell `PreToolUse` guards unwrap flagged wrapper invocations consistently.
  Core files: `hooks/lib/shell-parser.mjs`, `hooks/guard-secret-exposure.mjs`, `hooks/guard-remote-mutation.mjs`, `hooks/guard-symlinked-node-modules.mjs`.
  Verification: `npm test`.

## Gated on an in-flight milestone
<!-- Clear scope, but blocked until a named feature or refactor lands; must state the exact unblocking condition. -->

- None currently queued.

## Needs a decision
<!-- Blocked on an explicit product, UX, or architectural question; must state the concrete question to ask the user. -->

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
<!-- Blocked on an upstream release, real-world usage data, or a measured bottleneck; must state the trigger metric or event. -->

- **Optional Playwright `browser-driver` plugin/skill:**
  Re-introduce the headless Playwright REPL skill only if Antigravity's native browser tools prove insufficient for deterministic geometry verification in real projects.

## Not sanctioned
<!-- Recorded so the idea is not forgotten, but explicitly out of scope unless priorities change. -->

- **Single-agent fallback branches inside [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md):**
  Deliberately omitted so subagent-capable harnesses have zero prompt escape hatches to skip the cold Verifier subagent.

- **Custom git wrapper subcommands (`rig pull`, `rig merge`):**
  Rejected to avoid wrapping standard git operations in bespoke CLI abstractions;
  merge orchestration remains in [`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md) using native `git` commands.
