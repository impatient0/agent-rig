---
name: wrap-up
description: >-
  Use at the end of a coding session or when the user says "/wrap-up" or asks
  to wrap up. Verifies git/worktree cleanliness and test gates, routes
  undocumented decisions and deferred work to commits, ADRs, docs/backlog.md, or
  memory, checks cold-session doc reachability, and triages finish-now vs.
  defer items.
---

# End-of-Session Checkpoint (`wrap-up`)

Run this checklist before closing out a session so the next cold session starts with a clean tree, green tests, and zero trapped context in the conversation transcript.
Explicitly sequence all conversation archaeology and documentation updates inside the active worktree before merging into `main` so the main checkout edit guard is not triggered.

---

## Step 1 — Mechanical State & Test Gate

1. Run `git status --short` and `git worktree list`.
   - Flag any uncommitted edits, untracked scratch files, or orphaned worktrees.
2. Run the project's test suite and documentation linters (`scripts/check-doc-links.mjs` and `scripts/reflow-docs.mjs --check` if present, or `rig check-docs` and `rig reflow-docs --check`).
   - Do not declare wrap-up complete while tests or doc checks are failing.

---

## Step 2 — Conversation Archaeology (Route Trapped Knowledge)

Perform all documentation and rule updates inside the active worktree prior to merging into `main`.
Attempting to edit rules (such as [`rules/AGENTS.md`](../../rules/AGENTS.md)) or code comments in the root checkout after merging will trigger the main checkout edit guard.
Scan the session from the first turn to the last for four categories of knowledge that would otherwise vanish when the conversation closes:

1. **Architectural decisions & rejected alternatives:**
   - If the session settled a durable design choice or ruled out a plausible approach, record it in an ADR under [`docs/adr/0001-record-architecture-decisions.md`](../../docs/adr/0001-record-architecture-decisions.md) (or the relevant ADR file) so future sessions do not re-litigate it.
2. **Deliberate non-changes & deferred follow-ups:**
   - Route out-of-scope improvements, known edge cases, and follow-up tasks to [`docs/backlog.md`](../../docs/backlog.md) under `Unranked` (or run [`skills/backlog-audit/SKILL.md`](../backlog-audit/SKILL.md) to tier them immediately).
3. **Code-level invariants:**
   - If a subtle why-not comment belongs next to the code, add a concise comment citing the governing doc or ADR.
4. **Cross-session workflow rules:**
   - If a reusable process lesson emerged, propose adding it to [`rules/AGENTS.md`](../../rules/AGENTS.md).

---

## Step 3 — Cold-Session Reachability Check & Worktree Commit

Verify that every new or updated document under `docs/` is linked from an entry point a fresh agent session reads (`AGENTS.md`, `CLAUDE.md`, a `SKILL.md` file under `skills/`, or a rule file under `rules/`).
Verify that new permanent docs include a concise frontmatter `description` to keep the documentation index informative.
If adding a grouped set of documents in a subdirectory, add a `README.md` with `collection: true` frontmatter so `rig check-docs --fix` generates its local index and preserves BFS reachability from `AGENTS.md`.
Re-run the doc linters and commit all documentation changes directly to the feature branch inside the worktree before proceeding to merge.

---

## Step 4 — Finish-Now vs. Safe-to-Defer Triage

Present a short closing summary to the user separating:
- **Finish now (< 2 minutes):**
  Uncommitted changes, missing doc links, unmerged worktree branches ready for [`skills/merge-to-main/SKILL.md`](../merge-to-main/SKILL.md) (now carrying all committed documentation updates).
- **Recorded & safe to defer:**
  Items captured in [`docs/backlog.md`](../../docs/backlog.md) or ADRs with their exact file links.
