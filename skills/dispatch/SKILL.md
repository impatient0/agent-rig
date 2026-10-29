---
name: dispatch
description: >-
  Use when asked to sweep ready items from the backlog, execute a multi-slice
  implementation plan, or run tasks autonomously. Triages candidate items into
  Dispatch Now vs. Ask User First, dispatches isolated Worker subagents in git
  worktrees under five stop triggers, and requires a cold read-only Verifier
  subagent (Executor != Verifier) before accepting any diff.
---

# Subagent-First Task Dispatch (`dispatch`)

Run candidate tasks through a 2-layer **Tech Lead → Isolated Worker → Cold Verifier** pipeline so straightforward slices complete in parallel worktrees while ambiguous items are surfaced to the user immediately.

---

## Step 1 — Ground & Triage (Never Refuse a Whole Batch Over One Ambiguous Item)

Read the candidate items (from [`docs/backlog.md`](../../docs/backlog.md) or the user's prompt) and inspect the live codebase files they touch.
Partition every candidate item into one of two buckets:

1. **Bucket 1 — Dispatch Now (Autonomous Eligible):**
   Passes both gates:
   - **Gate A (Zero human-gated UI paths):**
     Does not modify visual layout, styling, or interactive flows governed by [`rules/ui-change-gate.md`](../../rules/ui-change-gate.md).
   - **Gate B (Grounded specification):**
     Has unambiguous acceptance criteria, known target files, and a deterministic verification command (`npm test`, `pytest`, `cargo test`, etc.).
2. **Bucket 2 — Ask User First:**
   Requires a product, UX, or architectural decision not answered by existing ADRs or docs.

**Immediate action after triage:**
- Dispatch Bucket 1 items (up to **3 slices per wave**) to Worker subagents right away.
- In the same turn (or while Workers run in the background), present the exact, code-grounded questions for Bucket 2 to the user.

---

## Step 2 — Write Grounded Task Briefs

Before spawning a Worker subagent, write a persistent task brief (in the session's Artifact directory or plan file) recording:
- **Base commit SHA** (`git rev-parse HEAD`).
- **Slice scope:**
  Exact files expected to be created or modified.
- **Invariants & acceptance criteria:**
  Citing the governing ADR or spec section.
- **Verification command:**
  Exact test and linter command the Worker must pass.
- **The 5 Stop Triggers** (copied verbatim into the Worker's prompt).

---

## Step 3 — Spawn Isolated Worker Subagents

Spawn one Worker subagent per independent Bucket 1 slice in its own isolated git worktree:
- **In Antigravity:**
  Call `invoke_subagent` with `Workspace: "share"` (or create a worktree under `.worktrees/<slug>` on branch `<type>/<slug>`).
- **In Claude Code:**
  Call `Task` / `Agent` with `isolation: "worktree"` and `run_in_background: true`.

### Worker Contract & Five Stop Triggers

Each Worker must stop and report back to the Tech Lead immediately instead of guessing if any of the five triggers fire:
1. **Human-gated file needed:**
   Completing the slice requires editing a UI/visual file covered by [`rules/ui-change-gate.md`](../../rules/ui-change-gate.md).
2. **Spec contradiction or gap:**
   Live code contradicts the task brief in a way that changes public interfaces, schema, or user-visible behavior.
3. **Unrelated test failure:**
   The baseline test suite fails outside the slice's scope.
4. **Scope explosion:**
   The change requires touching more than twice the files listed in the grounded brief or adding a new dependency.
5. **Two consecutive fix attempts fail:**
   The same test or build error persists after two targeted fix attempts.

### Commit & Trailer Discipline

Each Worker commits its completed slice on its worktree branch using Conventional Commits and appends one trailer per unmandated judgment call:

```text
Unmandated-call: <decision taken> — <1-line rationale> (<file>:<line>)
```

If zero unmandated calls were needed, the Worker appends:

```text
Unmandated-call: none
```

---

## Step 4 — Cold Verifier Subagent (Executor != Verifier)

When a Worker reports completion, the Tech Lead **must not** trust the Worker's summary or review the diff inside the Worker's context.
Spawn a fresh, read-only **Verifier** subagent (`research` in Antigravity; `Explore` in Claude Code) and pass it **only**:
1. The grounded task brief from Step 2.
2. The output of `git log -n 5 --format=fuller <base>..HEAD` and `git diff <base>..HEAD`.
3. The fresh test and doc-linter output (`scripts/check-doc-links.mjs` and `scripts/reflow-docs.mjs --check` when present).

The Cold Verifier checks four questions:
1. **Spec alignment:**
   Does the diff implement every requirement in the brief without gold-plating?
2. **Honest trailers:**
   Is every judgment call in the diff declared in an `Unmandated-call:` trailer?
3. **Boundary compliance:**
   Did the diff stay clear of human-gated UI files?
4. **Verification green:**
   Did the test suite and doc linters pass?

If the Verifier flags a defect, send the specific defect back to the Worker (up to 1 remediation round) or halt the slice and surface it to the user.

---

## Step 5 — Post-Wave Attribution Report (3-Slice Cap)

After at most **3 completed slices**, pause and present a concise attribution report to the user before starting another wave:
- Slices completed (branch names and commit SHAs).
- Cold Verifier findings.
- Consolidated table of every `Unmandated-call:` trailer across the wave so the user can approve or revert any judgment call in seconds.
