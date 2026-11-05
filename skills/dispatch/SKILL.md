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

Execute candidate tasks under **Gear 2 (Autonomous Dispatch)** through a **Tech Lead → Isolated Worker → Cold Verifier** pipeline so straightforward slices complete in parallel worktrees while ambiguous items are surfaced to the user immediately.

---

## Step 1 — Ground & Triage (The `Open Decisions = 0` Boundary)

Read the candidate items (from [`docs/backlog.md`](../../docs/backlog.md) or the user's prompt) and inspect the live codebase files they touch.
Explore the codebase **only** until high-level ambiguity is cleared and zero open product, UX, or architectural decisions remain.
Partition every candidate item into one of two buckets:

1. **Bucket 1 — Dispatch Now (Autonomous Eligible):**
   Passes both gates:
   - **Gate A (Zero unapproved human-gated paths):**
     Does not modify visual layout, styling, interactive flows, or domain/persistence contracts governed by human-in-the-loop gates ([`rules/ui-change-gate.md`](../../rules/ui-change-gate.md), [`rules/contract-change-gate.md`](../../rules/contract-change-gate.md)) without an explicit, approved specification in the task brief.
   - **Gate B (Grounded specification):**
     Has unambiguous acceptance criteria, at least one identified existing Core file, and a deterministic verification command (`npm test`, `pytest`, `cargo test`, etc.).
2. **Bucket 2 — Ask User First:**
   Requires a product, UX, or architectural decision not answered by existing ADRs, or touches a governed contract without prior approval.

**When to stop reading and delegate (Anti-Micromanagement):**
The moment remaining investigation is purely linear and deterministic (e.g., tracing internal helper line numbers or local call sites inside a known module), the Tech Lead **must stop reading code**, write the Task Brief, and dispatch the Worker.
Do not try to "make the Worker's life easier" by pre-solving local implementation mechanics, auditing every downstream call site, or preemptively smoothing out speed bumps before delegation.
Messy local discovery, edge-case wiring, and test fixture authoring belong to the Worker;
if the Worker genuinely hits an architectural fork or unexpected wall, the 5 Stop Triggers exist to escalate back to the Tech Lead.

**Parallel Wave Dispatch Over Conflict Aversion:**
Do not serialize slices into separate waves or linear branch stacks merely because they touch the same files (such as shared CLI entry points, `README.md`, or shared test files).
Sequence Slice B into a later wave **only** when Slice B functionally depends on a runtime contract, helper, or module introduced by Slice A.
Otherwise, dispatch up to **3 Bucket 1 slices concurrently** off `main` in the same turn and rely on the **On-Hold in Worktree** lifecycle (`git merge main` inside the Worker's worktree) to resolve textual merge collisions when landing on `main`.
In the same turn (or while Workers run in the background), present the exact, code-grounded questions for Bucket 2 to the user.

---

## Step 2 — Write Grounded Task Briefs

Before spawning a Worker subagent, construct a grounded task brief passed **inline** directly inside the subagent's invocation prompt (for both the Worker in Step 3 and the Cold Verifier in Step 4) rather than written to `<git-common-dir>/rig-briefs/<slug>.md` or disk files (which trigger `.git/` permission prompts and extra file I/O round-trips).
Record the following fields:
- **Base commit SHA** (`git rev-parse HEAD`).
- **Slice scope:**
  - **Core files (Required, $\ge 1$ existing file):**
    Existing repository entry points anchoring the slice (proving the Tech Lead grounded the task in live code).
  - **Suggested files to create (Optional):**
    Candidate paths for new modules or unit test files.
- **Human-gated boundary status:**
  Explicit confirmation that zero unapproved human-gated files ([`rules/ui-change-gate.md`](../../rules/ui-change-gate.md), [`rules/contract-change-gate.md`](../../rules/contract-change-gate.md)) are required, or links to the approved spec/signature.
- **Invariants & acceptance criteria:**
  Citing the governing ADR or spec section.
  State **what** behavior and invariants must hold, not **how** to write the code:
  do not paste implementation code blocks, shell script bodies, or line-by-line edit recipes into the brief.
- **Backlog isolation:**
  Workers must never edit [`docs/backlog.md`](../../docs/backlog.md) inside feature worktrees;
  only the Tech Lead updates [`docs/backlog.md`](../../docs/backlog.md) directly on `main` after a wave is merged.
- **Verification command:**
  Exact test and linter command the Worker must pass.
- **The 5 Stop Triggers** (governed by [`agents/worker.md`](../../agents/worker.md)).

---

## Step 3 — Spawn Isolated Worker Subagents

Spawn one Worker subagent per independent Bucket 1 slice in its own isolated git worktree.
If the harness provides native worktree isolation (such as subagent workspace branching), the Worker renames the initial harness-allocated branch rather than creating a second branch:

```bash
git branch -m <type>/<slug>
```

If the harness does not provide native worktree isolation, the orchestrator or Worker creates a dedicated linked worktree under `.worktrees/<slug>` on branch `<type>/<slug>`:

```bash
git worktree add .worktrees/<slug> -b <type>/<slug>
```

Workers operate in execution tier `worker` (subagent model `{{SUBAGENT_MODEL_WORKER}}`, target `{{MODEL_WORKER}}`, effort `{{EFFORT_WORKER}}`) governed by [`agents/worker.md`](../../agents/worker.md).

### Worker Lifecycle & Hold-Until-Merged

Workers follow a strict five-stage lifecycle:
1. **Spawn:**
   Launched in an isolated worktree with a grounded Task Brief.
2. **Implement & Self-Verify:**
   Traces root cause from Core files, writes code and tests, and verifies exit status `0`.
3. **Report:**
   Sends completion message with commit SHA and diff summary to Tech Lead.
4. **On-Hold in Worktree:**
   The Worker must remain alive and idle in its worktree until its branch is merged into `main`.
   If a subsequent merge collision occurs during `merge-to-main`, the Tech Lead messages this Worker to merge `main` and resolve conflicts in its native context.
5. **Terminate:**
   The Worker is suspended or terminated only after its branch has successfully landed in `main`.

### Worker Contract & Five Stop Triggers

Each Worker traces local call sites from the Core files and must stop and report back to the Tech Lead immediately if any of the five triggers fire:
1. **Human-gated boundary needed:**
   Completing the slice requires editing files covered by human-gated boundary rules ([`rules/ui-change-gate.md`](../../rules/ui-change-gate.md), [`rules/contract-change-gate.md`](../../rules/contract-change-gate.md)) not authorized in the brief.
2. **Spec contradiction or architectural fork:**
   Live code contradicts the brief, or multiple valid designs exist that alter contracts, public interfaces, schemas, or user-visible behavior.
3. **Unrelated test failure:**
   The baseline test suite fails outside the slice's scope.
4. **Scope explosion:**
   The change requires touching more than twice the Core files listed in the brief (or $> 4$ files when 1 Core file was listed), modifying an unrelated subsystem, or adding a new package dependency.
   This cap counts only production source and configuration files;
   test files (`tests/`, `*.test.*`, `*.spec.*`) and documentation or link migrations (`docs/`, `README.md`) are explicitly exempt from the modified-file count.
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

Contractual, schema, or behavioral forks must never be resolved via `Unmandated-call:` trailers;
they require halting under Stop Trigger #2.

---

## Step 4 — Cold Verifier Subagent (Executor != Verifier)

When a Worker reports completion, the Tech Lead **must not** trust the Worker's summary or review the diff inside the Worker's context.
Spawn a fresh **Verifier** subagent in execution tier `verifier` (subagent model `{{SUBAGENT_MODEL_VERIFIER}}`, target `{{MODEL_VERIFIER}}`, effort `{{EFFORT_VERIFIER}}`) following the exact prompt and checklist in [`agents/verifier.md`](../../agents/verifier.md).
The Verifier must have command execution permissions enabled so it runs `git log`, `git diff`, and the verification command directly in the target worktree.
Instruct the Verifier strictly in prompt not to edit files, stage changes, or create commits.
Do not act as an execution proxy;
pass the Verifier **only**:
1. The grounded task brief from Step 2 inline in its invocation prompt (base commit SHA, Core files, acceptance criteria, and verification command).
2. The target worktree path.

If the Verifier returns `VERDICT: FAIL`, send the specific `[BLOCKER]` items back to the Worker (up to 1 remediation round) or halt the slice and surface it to the user.

---

## Step 5 — Post-Wave Attribution Report (3-Slice Cap)

After at most **3 completed slices**, pause and present a concise attribution report to the user before starting another wave:
- Slices completed (branch names and commit SHAs).
- Cold Verifier verdict and findings.
- Consolidated table of every `Unmandated-call:` trailer across the wave so the user can approve or revert any judgment call in seconds.

Workers remain on hold in their worktrees until each slice is merged into `main` via [`skills/merge-to-main/SKILL.md`](../merge-to-main/SKILL.md);
only after a slice is committed to `main` is its worktree removed and its Worker subagent terminated.
Once the wave is merged to `main`, the Tech Lead prunes the completed items from [`docs/backlog.md`](../../docs/backlog.md) directly on `main`.
