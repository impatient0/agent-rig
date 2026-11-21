---
description: Binary rigged-or-unrigged repository boundary eliminating global hook, rule, and skill leakage into unrigged repositories.
---

# ADR 0004: Strict Unrigged Repository Isolation

## Status

Accepted.

## Context

When `agent-rig` is installed globally via `rig install` or `rig update`, it registers `PreToolUse` hooks, skills, and subagent definitions in the user's global harness directories (`~/.gemini/config/plugins/agent-rig/`, `~/.claude/`, `~/.codex/`, and `~/.cursor/`).
While working on the same machine in a repository that was deliberately not initialized with `agent-rig`, several global mechanisms still triggered:
1. **Unconditional Global Shell Guards:**
   Unlike `hooks/guard-main-checkout-edits.mjs`, neither `hooks/guard-remote-mutation.mjs` nor `hooks/guard-symlinked-node-modules.mjs` checked whether the target directory belonged to a rigged repository before prompting or blocking commands.
   As a result, running `ssh` or `git push` in an unrigged repository triggered the `agent-rig` remote/shared-state prompt.
2. **Global Rule Leakage in `~/.claude/rules/` and Plugin `rules/`:**
   Although [`rules/AGENTS.md`](../../rules/AGENTS.md) was already excluded from global `rules/` directories, `installForClaude` and `installForAntigravity` in [`bin/rig.mjs`](../../bin/rig.mjs) still copied [`rules/ui-change-gate.md`](../../rules/ui-change-gate.md) and [`rules/contract-change-gate.md`](../../rules/contract-change-gate.md) into `~/.claude/rules/` and `~/.gemini/config/plugins/agent-rig/rules/`.
   Because Claude Code automatically loads every Markdown file in `~/.claude/rules/` into the system prompt of every session on the machine, unrigged repositories received instructions referencing Gear 1 / Gear 2, `/dispatch`, `docs/adr/`, and linked git worktrees.
3. **Inconsistent Rigged-Repository Detection in `rig status` and `rig update`:**
   `statusRepo` in [`bin/rig.mjs`](../../bin/rig.mjs) treated any directory containing an `AGENTS.md` file or any non-empty `core.hooksPath` git config (such as `.husky`) as `mode: "attached"`, even if the repository was unrigged or had run `rig eject`.
4. **Generic Natural-Language Skill Triggers:**
   Global workflow skills ([`skills/dispatch/SKILL.md`](../../skills/dispatch/SKILL.md), [`skills/merge-to-main/SKILL.md`](../../skills/merge-to-main/SKILL.md), [`skills/wrap-up/SKILL.md`](../../skills/wrap-up/SKILL.md), and [`skills/doc-audit/SKILL.md`](../../skills/doc-audit/SKILL.md)) matched generic phrases like *"merge to main"* or *"wrap up"* without stating in their frontmatter or Step 1 preconditions that they apply only to rigged repositories.

## Decision

1. **Binary Rigged-or-Unrigged Invariant:**
   A repository on a machine with `agent-rig` installed is either **rigged** or **unrigged**—never "half-rigged."
   Global `agent-rig` installations must have zero behavioral side effects on unrigged repositories.
2. **Canonical Rigged-Repository Detection (`hooks/lib/hook-io.mjs`):**
   Centralize repository state detection in `hooks/lib/hook-io.mjs` and share it across all hooks and [`bin/rig.mjs`](../../bin/rig.mjs):
   - `isWorktreeRiggedRepo(repoRoot)`:
     true iff `.rig/hooks/pre-commit` or legacy ~~`scripts/git-hooks/pre-commit`~~ exists, or `git config --get core.hooksPath` resolves to `.rig/hooks` or ~~`scripts/git-hooks`~~.
   - `isRiggedRepo(repoRoot)`:
     true iff `isWorktreeRiggedRepo(repoRoot)` is true, or `.rig/hooks/guard-remote-mutation.mjs` or `.rig/bin/rig.mjs` exists (covering `rig init --no-worktrees`).
     When `rig eject` runs, it deletes `.rig/` and unsets `core.hooksPath`, immediately transitioning `isRiggedRepo` to `false` even though `AGENTS.md` and `docs/` are preserved.
   - `isDirectoryInRiggedRepo(targetPath, cwd)`:
     resolves the enclosing git repository (both worktree top-level and common repo root) or ancestor directory tree and checks `isRiggedRepo`.
3. **Gate All `PreToolUse` Hooks on Rigged Status:**
   - `hooks/guard-remote-mutation.mjs` tracks `activeCwd` across `cd <dir>` segments, subshells, nested shells, and `git -C <dir>` flags, enforcing remote/shared-state rules only when the effective target directory is inside a rigged repository.
   - `hooks/guard-symlinked-node-modules.mjs` resolves the effective package-manager target directory (including `cd <dir>` and `--prefix` / `-C` / `--dir` / `--cwd`) and enforces the symlinked `node_modules` guard only when that directory is inside a rigged repository.
   - `hooks/guard-main-checkout-edits.mjs` protects managed `AGENTS.md` blocks in any rigged repository (`isRiggedRepo`) and enforces main-checkout worktree isolation in worktree-rigged repositories (`isWorktreeRiggedRepo`).
4. **Vendor Gate Rules into Repo-Local `.rig/rules/` and Prune Global `rules/`:**
   - Stop installing [`rules/ui-change-gate.md`](../../rules/ui-change-gate.md) and [`rules/contract-change-gate.md`](../../rules/contract-change-gate.md) into global `~/.claude/rules/` or `~/.gemini/config/plugins/agent-rig/rules/`, and prune existing `agent-rig` rule files from those global locations during `rig install` and `rig update`.
   - Vendor [`rules/ui-change-gate.md`](../../rules/ui-change-gate.md) and [`rules/contract-change-gate.md`](../../rules/contract-change-gate.md) into `.rig/rules/` in every rigged repository alongside `.rig/rules/AGENTS.md`.
   - Update `rewriteDocLinks` in [`bin/rig.mjs`](../../bin/rig.mjs) so globally hydrated skills and subagents (`isGlobal: true`) rewrite `../../rules/` and `../rules/` links to repo-local `.rig/rules/`.
5. **Scope Workflow Skills and CLI Commands to Rigged Repositories:**
   - Specify in the frontmatter and Step 1 of [`skills/dispatch/SKILL.md`](../../skills/dispatch/SKILL.md), [`skills/merge-to-main/SKILL.md`](../../skills/merge-to-main/SKILL.md), [`skills/wrap-up/SKILL.md`](../../skills/wrap-up/SKILL.md), and [`skills/doc-audit/SKILL.md`](../../skills/doc-audit/SKILL.md) that they apply only to rigged repositories.
   - Use `isRiggedRepo` in `statusRepo`, `checkRepoPendingUpdates`, and `updateRepo` in [`bin/rig.mjs`](../../bin/rig.mjs) so unrigged repositories with their own `AGENTS.md` or third-party hook managers (such as `.husky`) are never misclassified as rigged.

## Consequences

- Unrigged repositories experience zero interference from globally installed `agent-rig` hooks, rules, or skills.
- Every internal link across global skills, global subagents, self-contained repositories, attached repositories, and standalone marketplace bundles resolves without relying on global `rules/` files.
