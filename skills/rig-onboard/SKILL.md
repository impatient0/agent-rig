---
name: rig-onboard
description: >-
  Use when bringing an existing repository with its own history, agent files
  (CLAUDE.md, GEMINI.md, .cursorrules), decision logs, or backlog under
  agent-rig conventions. Runs rig init in a worktree, ports project facts into
  AGENTS.md, converts legacy docs into ADRs with doc-audit, re-tiers the
  backlog last, and verifies that no dual-convention artifact remains.
---

# Onboard an Existing Repository (`rig-onboard`)

`rig init` is deliberately non-destructive:
it scaffolds files that do not exist yet and never rewrites what a project already has.
A repository that was worked on before `agent-rig` therefore still carries its own conventions afterwards (a `CLAUDE.md`, a chronological decision diary, a backlog full of finished slices, hard-wrapped docs), and two conventions side by side are worse than either one.
This skill finishes the job:
it converts everything that was done under the old conventions, so the repository ends with exactly one way of doing each thing.

The mechanical part is `rig init`;
the semantic part (deciding what is a project fact, what is a durable decision, what is finished) is this skill.

---

## Step 1 — Inventory Before Touching Anything

Read, do not edit:
1. **Legacy agent files:**
   `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/`, copilot instructions, `.claude/settings.json`, `.claude/commands/`, and any existing `AGENTS.md`.
2. **Every reference to them:**
   `grep -rnI` across docs, HTML mockups, code comments, and test titles (the doc linters do not see a citation like `(CLAUDE.md)` inside a code comment).
3. **Decision and planning docs:**
   decision diaries, design briefs, implementation notes, and the backlog.
4. **Live, gitignored data:**
   note every gitignored path that holds real data (databases, snapshots, credentials) and never move, delete, or rewrite it during onboarding.
5. **Baseline gates:**
   run the project's own test, type-check, and lint commands, plus `rig check-docs` and `rig reflow-docs --check`, and record the results so later failures can be attributed.

**Stop and ask the user** if a legacy agent file contains a project rule that contradicts a global `agent-rig` rule (for example "single branch, no worktrees" or "commit directly on main"):
the user decides whether the global rule wins or the project opts out (`rig init --no-worktrees`).

---

## Step 2 — Worktree & Mechanical Init

1. Run `rig init <repo>` on the main checkout.
   In a repository with history it creates the linked worktree `.worktrees/rig-init` on `chore/rig-init`, scaffolds and stages everything there (git hooks, `.gitignore` worktree hygiene, the `AGENTS.md` stub, the backlog doc, and ADR 0001 when missing), symlinks `node_modules`, and parks the main checkout on a detached `HEAD`.
2. Do all remaining work inside that worktree.
3. Commit the scaffolding as its own Conventional Commit before the semantic work.

---

## Step 3 — Port the Legacy Agent File Into `AGENTS.md`

Follow the "Writing a Per-Project `AGENTS.md`" section of the `agent-rig` README:
1. **Keep only what a cold session cannot infer quickly:**
   purpose and stack, exact build/test/verification commands, non-obvious domain invariants and footguns, infrastructure safety rules, and entry-point links to the project's docs.
2. **Drop what the global rules already say:**
   generic principles, debugging protocols, commit discipline, doc hygiene, definition of done, and harness-specific instructions (Plan Mode, a specific harness's task list).
3. **Delete the legacy file** and replace every reference found in Step 1 with `AGENTS.md`, including HTML mockups and code comments.
4. Never rewrite git history to remove old attribution trailers or session links;
   history stays as it was.

---

## Step 4 — Convert Legacy Docs (Run [`skills/doc-audit/SKILL.md`](../doc-audit/SKILL.md))

1. **Decision diaries become ADRs:**
   split a chronological log into a few numbered ADRs under `docs/adr/` grouped by concern (each under the 24,000-byte cap), keeping only what is still true.
   Superseded entries are resolved into the decision that replaced them, not copied side by side.
2. **One-off briefs and notes** either become an ADR (durable decisions), move into the backlog (open work), or are deleted (finished history that the code and ADRs already record).
3. **Re-point every citation** in docs, code comments, and test titles to the ADR that now holds the fact, then delete the old files.
4. **Ground claims against code:**
   fix statements that the code has since contradicted, strike through removed paths (`~~\`path\`~~`), and wrap bare backticked doc paths in Markdown links.
5. Run `rig reflow-docs` and `rig check-docs` until both pass.

---

## Step 5 — Re-Tier the Backlog Last (Run [`skills/backlog-audit/SKILL.md`](../backlog-audit/SKILL.md))

Only after the ADRs exist: remove items that are already built and recorded in an ADR, and classify every remaining item into the six actionability tiers.
Running it earlier would tier items against decisions that are about to move.

---

## Step 6 — Prove There Is No Dual Convention

All of the following must hold before handing over:
1. `grep -rnI` for every legacy file name and every deleted doc path returns nothing outside git history.
2. Every Markdown file is one sentence per line, and `rig check-docs` reports a fully reachable graph.
3. No doc or comment still describes the old workflow (single-branch commits, a decision diary, harness-specific modes).
4. The project's tests and type check pass in the worktree, with the same results as the baseline from Step 1 (or better).

---

## Step 7 — Cold Verifier, Then Merge Only on Request

1. Commit each step atomically with Conventional Commits and `Unmandated-call:` trailers (for example, how decisions were grouped into ADRs, or which backlog items were judged finished).
2. Spawn a fresh read-only Verifier per [`agents/verifier.md`](../../agents/verifier.md) with the inventory from Step 1 as the brief, the commit log, the diff, and the gate output.
3. Present the attribution table, and merge via [`skills/merge-to-main/SKILL.md`](../merge-to-main/SKILL.md) only when the user asks.
