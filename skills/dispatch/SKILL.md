---
name: dispatch
description: >-
  Use when the user invokes /dispatch, asks to "sweep the backlog", "execute
  implementation plan", "run tasks autonomously", or dispatch multi-task waves.
  Triages candidate items into Dispatch Now vs. Ask User First, dispatches
  isolated Worker subagents in git worktrees under five stop triggers, and
  requires a cold read-only Verifier subagent (Executor != Verifier) before
  accepting any diff.
---

# Subagent-First Task Dispatch (`dispatch`)

Execute candidate tasks under **Gear 2 (Autonomous Dispatch)** through a **Tech Lead → Isolated Worker → Cold Verifier** pipeline so straightforward slices complete in parallel worktrees while ambiguous items are surfaced to the user immediately.

---

## Step 1 — Ground & Triage (The `Open Decisions = 0` Boundary)

Before spawning any subagents, the Tech Lead MUST verify that the root checkout is on `main` (or `master`) with a clean working tree (`git status --short`).
Because harness worktree sharing (such as `Workspace: "share"`) copies uncommitted working-tree edits from the root checkout into every spawned Worker worktree, the Tech Lead MUST halt and prompt the user if uncommitted changes exist (or commit pending [`docs/backlog.md`](../../docs/backlog.md) edits on `main` first if authorized).

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

**Fulfilling Epistemic Hygiene during Triage:**
The Tech Lead fully satisfies the *Epistemic Hygiene & Investigation First* rule ([`rules/AGENTS.md`](../../rules/AGENTS.md)) for autonomous delegation once it confirms that:
1. The Core files and high-level module entry points exist on disk.
2. Zero unapproved human-gated boundaries ([`rules/ui-change-gate.md`](../../rules/ui-change-gate.md), [`rules/contract-change-gate.md`](../../rules/contract-change-gate.md)) are required.
3. Zero open product, UX, or architectural decisions remain (`Open Decisions = 0`).

The Tech Lead is **not** responsible for proving line-level root causes, tracing private helper call sites, or auditing internal function bodies during triage.
Under [`agents/worker.md`](../../agents/worker.md), that line-level epistemic hygiene belongs strictly to the Worker inside its isolated worktree.

**When to stop reading and delegate (Anti-Micromanagement):**
The moment remaining investigation is purely linear and deterministic (e.g., tracing internal helper line numbers, private subroutine branches, or local call sites inside a known module), the Tech Lead MUST stop reading code, construct the inline Task Brief, and dispatch the Worker.
The Tech Lead MUST NOT pre-solve local implementation mechanics, audit every downstream call site, or preemptively smooth out speed bumps before delegation.
Messy local discovery, edge-case wiring, and test fixture authoring belong to the Worker;
if the Worker genuinely hits an architectural fork or unexpected wall, the 5 Stop Triggers exist to escalate back to the Tech Lead.

**Parallel Wave Dispatch vs. Anticipated Structural Conflicts:**
The Tech Lead SHOULD NOT serialize slices into separate waves merely because they touch independent regions of the same file (such as separate CLI subcommands, separate sections of `README.md`, or separate test cases in a shared test file).
However, the Tech Lead MUST sequence Slice B behind Slice A (into the next wave or a linear branch stack) when:
1. Slice B functionally depends on a runtime contract, helper, or module introduced by Slice A.
2. Slice A performs a structural or code-motion refactor (moving, extracting, renaming, or rewriting the exact functions or code blocks that Slice B must modify), where running in parallel would force Worker B to implement against an obsolete layout and manually re-port its changes during conflict resolution.
3. The backlog item or user explicitly specifies an execution order.

For genuinely independent slices (including those with only incidental, localized file overlap), the Tech Lead SHOULD dispatch up to **3 Bucket 1 slices concurrently** off `main` in the same turn and rely on the **On-Hold in Worktree** lifecycle (`git merge main` inside the Worker's worktree) to resolve minor textual collisions when landing on `main`.
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
  the Tech Lead MUST NOT paste implementation code blocks, shell script bodies, or line-by-line edit recipes into the brief.
- **Backlog isolation:**
  Workers MUST NOT edit [`docs/backlog.md`](../../docs/backlog.md) inside feature worktrees;
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
   The Worker MUST remain alive and idle in its worktree until its branch is merged into `main`.
   If a subsequent merge collision occurs during `merge-to-main`, the Tech Lead messages this Worker to merge `main` and resolve conflicts in its native context.
5. **Terminate:**
   The Worker is suspended or terminated only after its branch has successfully landed in `main`.

### Worker Stop Triggers & Commit Trailer Contract

Each Worker traces local call sites from the Core files and is governed by the **Five Hard Stop Triggers** (human-gated boundary needed, spec contradiction or architectural fork, unrelated baseline test failure, scope explosion, and two consecutive failed fix attempts) and the **`Unmandated-call:` commit trailer contract** defined canonically in [`agents/worker.md`](../../agents/worker.md).
If any stop trigger fires, the Worker halts immediately in its worktree and reports the exact file, line, and question back to the Tech Lead.

---

## Step 4 — Cold Verifier Subagent (Executor != Verifier)

When a Worker reports completion, the Tech Lead MUST NOT trust the Worker's summary or review the diff inside the Worker's context.
Spawn a fresh **Verifier** subagent in execution tier `verifier` (subagent model `{{SUBAGENT_MODEL_VERIFIER}}`, target `{{MODEL_VERIFIER}}`, effort `{{EFFORT_VERIFIER}}`) following the exact prompt and checklist in [`agents/verifier.md`](../../agents/verifier.md).
The Verifier MUST have command execution permissions enabled so it runs `git log`, `git diff`, and the verification command directly in the target worktree.
The Tech Lead MUST instruct the Verifier strictly in prompt not to edit files, stage changes, or create commits.
The Tech Lead MUST NOT act as an execution proxy;
pass the Verifier ONLY:
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

---

## Output Format

Return a wave execution report using this exact structure:

```markdown
## Dispatch Wave Report: Wave <number>

- **Status:** COMPLETE | BLOCKED | PARTIAL
- **Slices Dispatched:** <count>
- **Cold Verifier Verdict:** PASS | FAIL

### Completed Slices
- `<slice-name>`: branch `<type>/<slug>` (`<commit-sha>`) — verified by Cold Verifier

### Bucket 2 & Blocked Slices
- `<slice-name>`: `<file>:<line> — <exact question, architectural fork, or human gate needed>` (or `None`)

### Consolidated Unmandated Calls
| Slice | Commit | Choice & Rationale | Citation |
| :--- | :--- | :--- | :--- |
| `<slug>` | `<sha>` | <choice — rationale or `none`> | `<file>:<line>` |

### Recommended Next Steps
- Merge verified branches into `main` via `skills/merge-to-main/SKILL.md`.
- Prune completed items from `docs/backlog.md` directly on `main`.
```
