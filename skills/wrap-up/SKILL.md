---
name: wrap-up
description: >-
  Use at the end of a coding session or after merging a wave when the user
  invokes /wrap-up, says "wrap up", "end session", "finish session", or requests
  a session checkpoint. Verifies git/worktree cleanliness and test gates, routes
  undocumented decisions and deferred work directly on main to ADRs,
  docs/backlog.md, or AGENTS.md, re-tiers backlog items for passive drift, and
  checks whether a cold-session /doc-audit is due.
---

# End-of-Session Checkpoint (`wrap-up`)

Run this checklist on `main` after landing any finished worktrees via [`skills/merge-to-main/SKILL.md`](../merge-to-main/SKILL.md) so the next cold session starts with a clean tree, green tests, an accurate backlog, and zero trapped context in the conversation transcript.
Because `wrap-up` is strictly a documentation and project-context procedure (touching only `docs/`, `AGENTS.md`, and `README.md`), its updates are permitted and committed directly on `main` without creating a separate worktree.

---

## Step 1 — Mechanical State & Test Gate

1. Run `git status --short` and `git worktree list`.
   - Flag any uncommitted edits, untracked scratch files, or open feature worktrees.
   - If a verified feature worktree is ready to land, merge it into `main` via [`skills/merge-to-main/SKILL.md`](../merge-to-main/SKILL.md) first (or confirm with the user that it is intentionally left in-flight) before committing `wrap-up` documentation updates on `main`.
<!-- RIG:IF distribution=rig -->
2. Run the project's test suite and documentation linters (`rig check-docs` and `rig reflow-docs --check`).
<!-- RIG:ELSE -->
2. Run the project's test suite and documentation linters (`node scripts/check-doc-links.mjs` and `node scripts/reflow-docs.mjs --check`).
<!-- RIG:ENDIF -->
   - Do not declare wrap-up complete while tests or doc checks are failing.

---

## Step 2 — Conversation Archaeology & Backlog Drift Check (On `main`)

Scan the session from the first turn to the last for three categories of durable knowledge that would otherwise vanish when the conversation closes:

1. **Architectural decisions & rejected alternatives (`docs/adr/`):**
   - If the session settled a durable design choice or ruled out a plausible approach, record it in an ADR under [`docs/adr/0001-record-architecture-decisions.md`](../../docs/adr/0001-record-architecture-decisions.md) (or a new numbered ADR file under `docs/adr/` with a concise frontmatter `description`) so future sessions do not re-litigate it.
2. **Backlog drift reconciliation & author-time placement ([`docs/backlog.md`](../../docs/backlog.md)):**
   - **Prune & re-tier existing items for passive drift:**
     Remove any backlog items completed during the session or wave;
     check `Gated on an in-flight milestone` and promote any item whose unblocking condition was satisfied by the merged changes;
     check `Needs a decision` and re-tier any item whose open question was resolved by a newly recorded ADR or user decision.
   - **Insert new deferred follow-ups & Worker escalations directly into actionability tiers:**
     For any out-of-scope improvements, deferred slices, or `Discovered Follow-Ups (Out of Scope)` reported by Workers, verify against `docs/adr/` (to confirm the idea was not previously rejected) and against live code (spawning a fast read-only `utility` research subagent in `{{SUBAGENT_MODEL_UTILITY}}` if the target module is outside the current session's context), then place the item directly into its matching tier in [`docs/backlog.md`](../../docs/backlog.md):
     - **`Do next`** — High-leverage, unblocked, spec-complete items ready for immediate execution or [`skills/dispatch/SKILL.md`](../dispatch/SKILL.md) (`Open Decisions = 0`, identified Core files, and verification command).
     - **`Ready, unblocked`** — Clear scope, identified Core files, and unambiguous acceptance criteria (`Open Decisions = 0`);
       can be picked up by a Worker subagent at any time without human input.
     - **`Gated on an in-flight milestone`** — Clear scope, but blocked until a named feature or refactor lands;
       must state the exact unblocking condition.
     - **`Needs a decision`** — Blocked on an explicit product, UX, or architectural question;
       must state the concrete question to ask the user.
     - **`Waiting on an external trigger`** — Blocked on an upstream release, real-world usage data, or a measured bottleneck;
       must state the trigger metric or event.
     - **`Not sanctioned`** — Recorded so the idea is not forgotten, but explicitly out of scope unless priorities change.
3. **Cross-session project context & workflow rules (`AGENTS.md`):**
   - If a non-obvious domain invariant, footgun, or reusable project convention emerged, update `# Project Context` in `AGENTS.md` (or propose an update to [`rules/AGENTS.md`](../../rules/AGENTS.md) when working on `agent-rig` itself).

---

## Step 3 — Cold-Session Reachability Check & Direct `main` Commit

Verify that every new or updated document under `docs/` is linked from an entry point a fresh agent session reads (`AGENTS.md`, `CLAUDE.md`, a `SKILL.md` file under `skills/`, or a rule file under `rules/`).
Verify that new permanent docs include a concise frontmatter `description` to keep the documentation index informative.
If adding a grouped set of documents in a subdirectory, add a `README.md` with `collection: true` frontmatter so the documentation index generator maintains its local index and preserves BFS reachability from `AGENTS.md`.
<!-- RIG:IF distribution=rig -->
Run `rig reflow-docs` and `rig check-docs --fix` (then verify with `rig check-docs` and `rig reflow-docs --check`), and commit the documentation updates directly on `main` with a `docs:` or `docs(backlog):` Conventional Commit and `Unmandated-call:` trailer.
<!-- RIG:ELSE -->
Run `node scripts/reflow-docs.mjs` and `node scripts/check-doc-links.mjs --fix` (then verify with `node scripts/check-doc-links.mjs` and `node scripts/reflow-docs.mjs --check`), and commit the documentation updates directly on `main` with a `docs:` or `docs(backlog):` Conventional Commit and `Unmandated-call:` trailer.
<!-- RIG:ENDIF -->

---

## Step 4 — Check `last-doc-audit` Freshness & Triage Closing Summary

1. **Inspect the `doc-audit` tracking stamp in [`docs/backlog.md`](../../docs/backlog.md):**
   Read `<!-- last-doc-audit: YYYY-MM-DD commit=<short-sha> -->` at the top of [`docs/backlog.md`](../../docs/backlog.md) and check how many days and commits (`git rev-list --count <short-sha>..HEAD`) have elapsed since the last full documentation audit.
   - If the stamp is missing, the commit SHA is placeholder `0000000`, more than **14 days** have elapsed, or more than **20 commits** have landed since `<short-sha>`, add a reminder in the report prompting the user to run `/doc-audit` ([`skills/doc-audit/SKILL.md`](../doc-audit/SKILL.md)) **in a fresh, clean session**.
   - **Never offer or attempt to execute `doc-audit` inside the current session**;
     only notify the user in the report so they can invoke it in a clean context window.
2. **Present the closing summary separating:**
   - **Finish now (< 2 minutes):**
     Uncommitted changes, missing doc links, or unmerged worktree branches ready for [`skills/merge-to-main/SKILL.md`](../merge-to-main/SKILL.md).
   - **Recorded & safe to defer:**
     Items captured or re-tiered in [`docs/backlog.md`](../../docs/backlog.md) or ADRs with their exact file links.

---

## Output Format

Return an end-of-session wrap-up report using this exact structure:

```markdown
## Session Wrap-Up Report

- **Working Tree State:** CLEAN | DIRTY
- **Active Worktrees:** <count> active (<paths or none>)
- **Test & Doc Gate:** PASS | FAIL
- **Doc Audit Status:** UP TO DATE (<days>d, <commits> commits since <sha>) | DUE — run `/doc-audit` in a clean session (<days>d, <commits> commits since <sha>)

### Routed Session Knowledge
- **ADRs Created / Updated:** None (or `docs/adr/<file>.md — <summary>`)
- **Backlog Items Pruned / Re-Tiered:** None (or `<item title>: <old-tier> -> <new-tier or pruned>`)
- **Backlog Items Queued:** None (or `<item title> in docs/backlog.md (<tier>)`)
- **Project Context / Rules Updated:** None (or `AGENTS.md — <summary>`)

### Finish Now (< 2 minutes)
- None (or `<actionable immediate item, e.g. merge branch <branch> via skills/merge-to-main/SKILL.md>`)

### Safe to Defer
- None (or `<deferred item title> — recorded in <path> (<tier>)`)
```
