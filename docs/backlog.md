# Backlog (`agent-rig`)

<!-- last-doc-audit: 2026-11-18 commit=64682da -->
<!-- Authoring rule: Check docs/adr/ for prior rejections and verify against live code (using a read-only utility research subagent if outside current session context) before inserting any item directly into its actionability tier below. -->

## Do next
<!-- High-leverage, unblocked, spec-complete items ready for immediate execution or dispatch (Open Decisions = 0, identified Core files, and verification command). -->

- **Shared pipeline-aware shell parser (`shell-parser.mjs`) and configurable `.rig/deny` policy engine (`deny-policy.mjs` + `deny.default`):**
  Governed by [`docs/adr/0006-configurable-deny-policy-and-secops-guards.md`](adr/0006-configurable-deny-policy-and-secops-guards.md).
  Extract duplicated shell tokenization from `hooks/guard-remote-mutation.mjs` and `hooks/guard-symlinked-node-modules.mjs` into `shell-parser.mjs` under `hooks/lib/` preserving list separators (`;`, `&&`, `||`, `\n`), pipeline stages (`|`, `|&`), per-stage redirections (`<`, `>`, `>>`, `2>&1`, `/dev/null`), subshells, nested shells, wrappers, and `cd` tracking, and migrate both existing shell hooks onto it with zero behavior regressions.
  Implement `deny-policy.mjs` under `hooks/lib/` and `deny.default` under `templates/` supporting `@defaults` expansion, top-to-bottom last-match-wins path/directory globs (`~/` expansion and `!pattern` negations), named `@content:<id>`, `@shell:<id>`, and `@remote:<id>` switches (and `!@<category>:<id>` negations), `--stealth` `repoRoot` fallback via `hooks/lib/hook-io.mjs` (`resolveGitRoots`), `.rig/deny.local` untracked overrides, and `.rig/deny` seeding on `rig init` and `rig update --repo` in `bin/rig.mjs` (plus `VENDORED_RIG_FILES` and `rewriteDocLinks`).
  Core files: `hooks/guard-remote-mutation.mjs`, `hooks/guard-symlinked-node-modules.mjs`, `hooks/lib/hook-io.mjs`, `bin/rig.mjs`.
  Verification: `npm test`.

## Ready, unblocked
<!-- Clear scope, identified Core files, and unambiguous acceptance criteria (Open Decisions = 0); can be picked up by a Worker subagent at any time without human input. -->

- None currently queued.

## Gated on an in-flight milestone
<!-- Clear scope, but blocked until a named feature or refactor lands; must state the exact unblocking condition. -->

- **Cross-harness `PreToolUse` secret-exposure guard (`guard-secret-exposure.mjs`), `.rig/deny` anti-tamper lock, and SOPS handoff skill updates:**
  Unblocked once the shared shell parser and `.rig/deny` policy engine slice lands (or stacked linearly on its branch) per [`docs/adr/0006-configurable-deny-policy-and-secops-guards.md`](adr/0006-configurable-deny-policy-and-secops-guards.md).
  Extend `parseHookInput` in `hooks/lib/hook-io.mjs` for cross-harness read/search arguments (`read_file`, `view_file`, `view_file_outline`, `view_code_item`, `grep_search`, `Read`, `Grep`), implement `guard-secret-exposure.mjs` under `hooks/` gated on `isDirectoryInRiggedRepo(cwd) || (targetPath && isDirectoryInRiggedRepo(targetPath))` covering `.rig/deny` globs, `@content:*` header checks (`private-key`, `unencrypted-sops`, `npmrc-auth`), `@shell:*` stdout leak rules (`file-read`, `sops-decrypt`, `env-dump`, `cli-secret-dump`), and hardcoded anti-tamper denial on `.rig/deny` / `.rig/deny.local` mutations across both `hooks/guard-main-checkout-edits.mjs` and shell commands.
  Wire `guard-secret-exposure.mjs` into `hooks.json`, `hooks/claude-hooks.json`, and `bin/rig.mjs` (`installForClaude`, `mergeClaudeSettings`, `VENDORED_RIG_FILES`, `isRiggedRepo`, `checkRepoPendingUpdates`, `updateRepo`, `initRepo`, `rewriteDocLinks`), and update [`skills/secure-credential-handoff/SKILL.md`](../skills/secure-credential-handoff/SKILL.md) with `sops exec-env` / `sops exec-file` and `grep -q` patterns.
  Core files: `hooks/lib/hook-io.mjs`, `hooks/guard-main-checkout-edits.mjs`, `hooks.json`, `hooks/claude-hooks.json`, `bin/rig.mjs`, [`skills/secure-credential-handoff/SKILL.md`](../skills/secure-credential-handoff/SKILL.md).
  Verification: `npm test`.

- **IaC & remote orchestration guards in `hooks/guard-remote-mutation.mjs` and comprehensive `.rig/deny` / SecOps documentation:**
  Unblocked once the `.rig/deny` policy engine and `guard-secret-exposure.mjs` slices land (or stacked linearly on Slice 2) per [`docs/adr/0006-configurable-deny-policy-and-secops-guards.md`](adr/0006-configurable-deny-policy-and-secops-guards.md).
  Add token-aware checks to `hooks/guard-remote-mutation.mjs` gated on `isDirectoryInRiggedRepo(activeCwd)` and `@remote:*` switches in `.rig/deny` for `ansible`/`ansible-playbook`, `terraform`/`tofu`/`terragrunt` (including `-chdir=<dir>` and `@remote:terraform-plan`), `kubectl`/`helm` (offline allowlist + `@remote:kubectl-read`/`@remote:helm-read` + mutation `ask`), and `rclone` (`<remote>:` and `:backend:` specs with `@remote:rclone-read` + mutation `ask`).
  Document how `.rig/deny` (`@defaults`, last-match-wins globs, `!pattern` and `!@rule-id` overrides, `.rig/deny.local`, `--stealth` behavior, and anti-tamper rules), `guard-secret-exposure.mjs` (SOPS workflows, file/content/shell rules), and the IaC remote guards work and how to use them in [`README.md`](../README.md) and [`docs/field-notes.md`](field-notes.md).
  Core files: `hooks/guard-remote-mutation.mjs`, [`README.md`](../README.md), [`docs/field-notes.md`](field-notes.md).
  Verification: `npm test`.

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
