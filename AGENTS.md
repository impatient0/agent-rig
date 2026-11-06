<!-- AGENT-RIG:START -->
<!-- Managed by `rig init` / `rig update`. Do not edit between AGENT-RIG:START and AGENT-RIG:END. -->
# Universal Agentic Engineering Rules (`agent-rig`)

## Epistemic Hygiene & Investigation First

Never speculate about code, configuration, or behavior you have not opened and read.
During direct interactive pairing, state the root cause and cite the exact file and line that proves it before proposing or executing a fix.
When preparing tasks for autonomous delegation, ground requirements against live core files and existing ADRs until zero open product, UX, or architectural decisions remain before writing a task brief.
If a requirement has genuine ambiguity that changes data structures, public interfaces, runtime schemas, or user-visible behavior, stop and ask a brief, direct question before writing code.
Do not gold-plate, add speculative abstractions, or refactor adjacent code outside the task scope.

---

## Session-Per-Worktree Isolation

By default, parallel agent sessions never share a working tree:

1. **Root checkout stays attached to `main` as a merge-only trunk for code** and code files are never edited directly.
   Documentation and backlog files (`docs/`, `README.md`) may be edited and committed directly on `main`, guarded by automated doc linters in `.rig/hooks/pre-commit`.
   `hooks/guard-main-checkout-edits.mjs` blocks direct code edits, and `.rig/hooks/pre-commit` ensures only verified merge commits, verified doc-only commits, or `.rig/` / vendored harness asset updates land on `main`.
   Standard operations (`git pull`, `git status`) work natively in the root checkout.
2. **Work happens in a linked git worktree** on a `<type>/<slug>` branch (`feature/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`):
   - When dispatching subagents, spawn each Worker in an isolated worktree using the harness's native worktree-isolation option (or create a worktree under `.worktrees/<slug>`).
   - When working directly in a session, enter a linked worktree via the harness's native worktree tool or `git worktree add .worktrees/<slug> -b <type>/<slug>` before editing any file.
   - If the repository has a `node_modules` directory at the root, symlink it into the worktree (`ln -s ../../node_modules node_modules`) unless the branch modifies dependencies.
     `hooks/guard-symlinked-node-modules.mjs` blocks `npm`/`pnpm`/`yarn`/`bun` installs against a symlinked `node_modules`.
3. **Merging to `main` happens only when requested by the user**:
   - **Local single-developer workflow:**
     Merges verified worktree branches in the attached root checkout via [`skills/merge-to-main/SKILL.md`](skills/merge-to-main/SKILL.md).
   - **Multi-developer / team Pull Request workflow:**
     Still develops and verifies every slice inside an isolated linked worktree (`<type>/<slug>`) and runs the Cold Verifier ([`agents/verifier.md`](agents/verifier.md)).
     When authorized by the user, push the worktree branch to the remote to open a Pull Request verified by CI (`rig-verify.yml`, seeded from templates/ci/rig-verify.yml) before merging into `main`.
     After merge, the root checkout runs `git pull` and removes the linked worktree.

---

## Two-Gear Execution Model & `Executor != Verifier`

Work is structured into two explicit, user-selected operational gears while preserving `Executor != Verifier` and session-per-worktree isolation across both gears:

1. **Gear 1 — Interactive Pairing (Default Mode):**
   The main session operates as a hands-on **Player-Coach** in the `architect` tier.
   It reads code deeply alongside the user, co-designs domain contracts, algorithms, and interfaces, edits files directly inside a linked git worktree, and commits with `Unmandated-call:` trailers.
   Before declaring a slice complete or merging to `main`, it must spawn a fresh **Verifier** subagent governed by [`agents/verifier.md`](agents/verifier.md) with command execution enabled to run the verification gate live in the worktree without editing files.
2. **Gear 2 — Autonomous Dispatch ([`skills/dispatch/SKILL.md`](skills/dispatch/SKILL.md)):**
   Invoked explicitly when the user requests `/dispatch`, "sweep the backlog", or runs a multi-slice implementation plan.
   The main session operates as a **Tech Lead Orchestrator**:
   it grounds candidate items only until the `Open Decisions = 0` boundary, partitions tasks into **Bucket 1 (Dispatch Now)** and **Bucket 2 (Ask User First)**, dispatches isolated **Worker** subagents governed by [`agents/worker.md`](agents/worker.md) in linked worktrees, and audits each completed Worker branch with a fresh **Verifier** subagent.
   The Tech Lead must stop investigating as soon as high-level ambiguity is cleared rather than pre-solving local implementation details or writing code in Task Briefs, must dispatch functionally independent slices concurrently rather than serializing them out of file-conflict aversion, and updates the backlog (`docs/`) directly on `main` after a wave is merged rather than delegating backlog edits to Workers.

### Human-Gated Boundaries (UI & Domain Contracts)

Autonomous subagents may not mutate visual layouts or system contracts without prior human authorization:
- **UI & Interaction Boundary:**
  Governed by [`rules/ui-change-gate.md`](rules/ui-change-gate.md).
- **Domain & Schema Contract Boundary:**
  Governed by [`rules/contract-change-gate.md`](rules/contract-change-gate.md).

### Execution Tiers & Subagent Model Selection

Work is structured across four canonical execution tiers governed by the active profile `antigravity-budget`:
- **`architect`** (`gemini-4-argon`, effort `high`):
  Main session / Tech Lead, triage, backlog auditing ([`skills/backlog-audit/SKILL.md`](skills/backlog-audit/SKILL.md)), doc auditing ([`skills/doc-audit/SKILL.md`](skills/doc-audit/SKILL.md)), repo onboarding ([`skills/rig-onboard/SKILL.md`](skills/rig-onboard/SKILL.md)), session wrap-up ([`skills/wrap-up/SKILL.md`](skills/wrap-up/SKILL.md)), ADR authoring, and handling Worker stop triggers.
- **`worker`** (subagent model `flash`, target `gemini-3-8-flash`, effort `high`):
  Isolated implementation subagents running in linked worktrees governed by [`agents/worker.md`](agents/worker.md).
- **`verifier`** (subagent model `flash`, target `gemini-3-8-flash`, effort `medium`):
  Cold audit subagent governed by [`agents/verifier.md`](agents/verifier.md).
- **`utility`** (subagent model `flash_lite`, target `gemini-3-8-flash`, effort `low`):
  Fast mechanical procedures ([`skills/merge-to-main/SKILL.md`](skills/merge-to-main/SKILL.md), [`skills/rig-update/SKILL.md`](skills/rig-update/SKILL.md), [`skills/secure-credential-handoff/SKILL.md`](skills/secure-credential-handoff/SKILL.md)) and targeted read-only research subagents.
  Whenever launching a subagent, explicitly pass the tier's resolved subagent model argument (`flash` for Workers, `flash` for Verifiers, `flash_lite` for Utility tasks) rather than defaulting to `inherit`.

---

## CLI Entry Points (`rig`)

Agents can discover and run core `rig` CLI commands directly across sessions and worktrees:
- `rig status [<target-dir>]` — inspect repository rig configuration, active hooks, and installed skills.
- `rig check-docs [<target-dir>]` — verify internal Markdown link resolution, heading anchors, and doc reachability.
- `rig reflow-docs [<target-dir>] [--check]` — enforce or verify one-sentence-per-line Markdown formatting.
- `rig attach [<target-dir>]` — configure `core.hooksPath .rig/hooks`, attach `main` in the root checkout, and register a cloned repository without creating scaffolding worktrees.
- `rig update [--all] [--repo <target-dir>]` — refresh global harness plugins, check initialized repositories for pending updates, or selectively update clean repositories ([`skills/rig-update/SKILL.md`](skills/rig-update/SKILL.md)).
- `rig eject [<target-dir>]` — cleanly remove `.rig/` and unset `core.hooksPath` while preserving `AGENTS.md` and `docs/`.

---

## Commit Discipline & Attribution Trailers

- Use Conventional Commits (`feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `test: ...`, `chore: ...`).
- Keep commits atomic: one logical slice per commit, with tests passing before commit.
- On delegated or autonomous slices, record `Unmandated-call: <choice> — <rationale> (<file>:<line>)` (or `Unmandated-call: none`) on every commit per the canonical trailer rules, positive/negative examples, and Stop Trigger #2 boundary in [`agents/worker.md`](agents/worker.md).

---

## Documentation Graph Rules

Every Markdown file in a rigged repository follows two mechanical invariants enforced by `scripts/check-doc-links.mjs` and `scripts/reflow-docs.mjs`:

1. **One sentence per line:**
   Do not hard-wrap mid-sentence or put multiple sentences on one line.
2. **Resolved, reachable link graph:**
   - Every relative link and `#fragment` heading anchor must resolve.
   - Cross-references to repo docs must use standard Markdown links, never wiki-style brackets, wildcard globs, or bare backticked doc paths.
   - Every file under `docs/` must be reachable from `README.md`, `AGENTS.md`, `CLAUDE.md`, a `SKILL.md` file under `skills/`, or a rule file under `rules/`.
   - Every backticked repo path (`src/...`, `scripts/...`, `bin/...`, `hooks/...`, `skills/...`, `agents/...`) must exist on disk or be struck through (`~~\`scripts/removed.mjs\`~~`) when documenting a deletion.
<!-- AGENT-RIG:END -->

# Project Context (`agent-rig`)

`agent-rig` is a subagent-first, platform-agnostic agentic workflow rig providing multi-protocol `PreToolUse` guards, Triage/Worker/Verifier task dispatch, git worktree isolation locks, and documentation graph linters.

- **Test and verification gate** — `npm test` (runs `node --test tests/*.test.mjs`, `scripts/check-doc-links.mjs`, and `scripts/reflow-docs.mjs --check`)
- **CLI entry point** — `bin/rig.mjs` (`rig install`, `rig update`, `rig profile`, `rig model resolve`, `rig init`, `rig attach`, `rig hook pre-commit`, `rig check-docs`, `rig reflow-docs`, `rig status`, `rig eject`)
- **Architecture and empirical rationale** — [`docs/field-notes.md`](docs/field-notes.md), [`docs/adr/0001-record-architecture-decisions.md`](docs/adr/0001-record-architecture-decisions.md), and [`docs/adr/0002-two-gear-execution-and-worker-subagent.md`](docs/adr/0002-two-gear-execution-and-worker-subagent.md)
- **Active backlog** — [`docs/backlog.md`](docs/backlog.md)

---

## Rules, Subagents & Skills Index

- **Universal Engineering Rules** — [`rules/AGENTS.md`](rules/AGENTS.md)
- **Human-in-the-Loop UI Gate** — [`rules/ui-change-gate.md`](rules/ui-change-gate.md)
- **Human-in-the-Loop Contract Gate** — [`rules/contract-change-gate.md`](rules/contract-change-gate.md)
- **Isolated Worker Subagent** — [`agents/worker.md`](agents/worker.md)
- **Cold Verifier Subagent** — [`agents/verifier.md`](agents/verifier.md)
- **Skills (`skills/`):**
  - [`skills/dispatch/SKILL.md`](skills/dispatch/SKILL.md) — Triage → Isolated Worker → Cold Verifier execution pipeline
  - [`skills/wrap-up/SKILL.md`](skills/wrap-up/SKILL.md) — End-of-session audit, decision routing, and reachability check
  - [`skills/backlog-audit/SKILL.md`](skills/backlog-audit/SKILL.md) — Actionability tiering and ADR-rejection check for [`docs/backlog.md`](docs/backlog.md)
  - [`skills/doc-audit/SKILL.md`](skills/doc-audit/SKILL.md) — Token-budget, duplication, and code-grounding audit for Markdown docs
  - [`skills/rig-onboard/SKILL.md`](skills/rig-onboard/SKILL.md) — Legacy repository onboarding workflow eliminating dual-convention state
  - [`skills/rig-update/SKILL.md`](skills/rig-update/SKILL.md) — Global harness and clean-trunk repository asset update and verification procedure
  - [`skills/merge-to-main/SKILL.md`](skills/merge-to-main/SKILL.md) — Safe worktree-to-`main` merge procedure in the root checkout
  - [`skills/secure-credential-handoff/SKILL.md`](skills/secure-credential-handoff/SKILL.md) — Mode-`0600` secret handoff for non-interactive shell calls
