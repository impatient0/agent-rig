# Field Notes: Why Each Mechanism Exists

Every guard, skill, and linter in `agent-rig` was created only after a written prompt rule failed in a real session and the failure mode was measured.

---

## 1. Why `dispatch` Splits Triage From Execution (And Why Executor != Verifier)

### Failure Mode A: All-or-Nothing Batch Refusal

In earlier iterations (`autonomous-slice`), autonomous execution was gated on whether an entire multi-slice batch was 100% free of open questions.
In practice, real project backlogs almost always mix three straightforward items with one item that needs a 30-second human decision.
When asked whether the batch qualified for autonomous execution, the model consistently defaulted to caution and recommended running the entire list manually.

**Fix in [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md):**
Triage is now per-item rather than per-batch.
The Tech Lead splits candidates into **Bucket 1 (Dispatch Now)** and **Bucket 2 (Ask User First)**, spawns isolated Worker subagents for Bucket 1 immediately, and asks the concrete Bucket 2 questions while the Workers run in the background.

### Failure Mode B: Single-Context Confirmation Bias

When the same agent context writes a 300-line diff and then "reviews" its own diff before committing, its context window is saturated with the chain-of-thought reasoning that justified its shortcuts.
Self-reviews in the executor's context routinely missed subtle spec drift and omitted `Unmandated-call:` trailers.

**Fix in [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md):**
Both Antigravity (`Workspace: "share"` + `research` subagent) and Claude Code (`isolation: "worktree"` + `Explore` subagent) support isolated subagents.
`dispatch` enforces **Executor != Verifier**:
a fresh Verifier subagent receives *only* the grounded task brief and commit range, running verification commands directly in the worktree without editing files or receiving the Worker's reasoning.

---

## 2. Why Worktree Isolation Uses Both `PreToolUse` and Git Hooks

Written instructions in `AGENTS.md` telling sessions to work in a linked git worktree were occasionally bypassed during quick fixes—either via direct file-edit tool calls in the root checkout or via `sed -i` shell commands.

**Fix:**
1. `hooks/guard-main-checkout-edits.mjs` intercepts file-edit tools before code files are touched in the main checkout and returns the exact worktree setup command, while permitting direct edits to documentation and backlog files (`docs/`, `README.md`).
2. `.rig/hooks/pre-commit` enforces that the root checkout only accepts merge commits onto `main` (and the initial commit on an unborn repo) or doc-only commits verified by doc linters, while refusing direct code edits and non-merge code commits. ~~\`scripts/git-hooks/pre-merge-commit\`~~ was removed because verified merges now happen cleanly in the root checkout rather than inside a worktree.
3. Keeping the root checkout attached to `main` as a merge-only trunk for code allows standard operations (`git pull`, `git status`, `git branch -d`) to work natively without detached-`HEAD` friction, while [`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md) merges into `main` directly in the root checkout.

---

## 3. Why `guard-symlinked-node-modules.mjs` Tracks `cd <dir> &&`

Sharing `node_modules` across worktrees via a symlink (`ln -s ../../node_modules node_modules`) saves gigabytes of disk space and install time.
However, running `npm ci` or `npm install` inside a worktree with a symlinked `node_modules` mutates or wipes the shared root `node_modules` tree, breaking parallel worktrees mid-test.
Furthermore, in stateless shell tools (such as Antigravity's `run_command`, where every command starts at the workspace root), agents run `cd .worktrees/<slug> && npm install` rather than invoking `npm` with `cwd` already inside the worktree.

**Fix in `hooks/guard-symlinked-node-modules.mjs`:**
Parses command chains for leading `cd <dir>` segments as well as `--prefix`, `-C`, `--dir`, and `--cwd` flags across `npm`, `pnpm`, `yarn`, and `bun`, denying the command if the resolved target directory's `node_modules` is a symlink.

---

## 4. Why Documentation Is Enforced as a Directed Graph + One Sentence Per Line

1. **One sentence per line (`scripts/reflow-docs.mjs`):**
   Hard-wrapping paragraphs at 80 columns splits multi-word phrases across line breaks, breaking `grep` / `rg` searches and turning one-word edits into full-paragraph git diffs.
2. **Link & reachability graph (`scripts/check-doc-links.mjs`):**
   Unlinked files under `docs/` become invisible to cold sessions, and unverified backticked file paths rot silently when code is moved.

---

## 5. Why Two-Gear Execution and the `Open Decisions = 0` Boundary Exist

### Failure Mode A: The Double-Read Tax

In earlier dispatch designs, [`rules/AGENTS.md`](../rules/AGENTS.md) applied line-level epistemic rules globally, requiring the Tech Lead to cite exact file and line numbers before proposing a change.
For delegated tasks, this forced the architect tier to mentally solve 85% of the task during triage.
When the isolated Worker subagent spawned in a fresh context, it had to re-read those exact same files from scratch to implement the fix, paying token costs and latency twice.

### Failure Mode B: The "Manager Who Stopped Coding" Syndrome

Attempting to eliminate the Double-Read Tax by enforcing universal subagent delegation for all tasks ($N=1$) produced an opposite failure mode:
the Tech Lead was forbidden from inspecting code deeply, burying the actual code two layers away from the user.
The user was reduced to managing Jira tickets, and models running on lower tiers produced locally optimal diffs that passed tests but degraded overall architectural taste.

### Fix: Two User-Selected Gears & The `Open Decisions = 0` Boundary

`agent-rig` separates execution into two explicit, user-selected operational gears while keeping `Executor != Verifier` invariant across both:
1. **Gear 1 — Interactive Pairing (Default Mode):**
   The main session acts as a Player-Coach, inspecting code deeply with the user and writing diffs directly in a linked worktree.
   Before completing a slice, it spawns a cold Verifier subagent governed by [`agents/verifier.md`](../agents/verifier.md) to audit the diff.
2. **Gear 2 — Autonomous Dispatch ([`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md)):**
   Triggered explicitly by the user (`/dispatch` or backlog sweep).
   The Tech Lead explores only until **`Open Decisions = 0`** (Gate A human gates under `rules/` cleared, Gate B core files and acceptance criteria known).
   The Tech Lead dispatches an isolated Worker subagent governed by [`agents/worker.md`](../agents/worker.md) to trace line-level root causes under five hard stop triggers.

---

## 6. Why Task Briefs Are Passed Inline in Prompts

In earlier iterations, [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md) wrote Task Briefs to `<git-common-dir>/rig-briefs/<slug>.md`.
In practice, agent harnesses guard `.git/` at the tool boundary, triggering manual permission approval prompts on every file write into `.git/`.
Furthermore, every subagent invocation tool natively accepts an invocation prompt string whose complete trajectory is already persisted in the harness session transcript.
Passing grounded Task Briefs directly in the subagent's invocation prompt eliminates redundant disk round-trips and prevents spurious harness permission prompts.

---

## 7. Why `.rig/` Commits Are Permitted Directly on `main`/`master`

Pre-commit hooks originally restricted commits in the root checkout exclusively to verified merge commits and documentation-only changes.
When upstream `agent-rig` changes, initialized repositories receive updated git hooks (`.rig/hooks/`) or updated asset files.
Blocking `.rig/` commits on `main` forced developers to create a temporary git worktree merely to accept a non-code hook refresh.
Permitting `.rig/` and legacy ~~`scripts/git-hooks/`~~ deletion commits directly on `main`/`master` allows `rig update --repo <dir>` and `rig update --all` to automatically stage and commit repository asset updates on clean trunk checkouts without manual worktree scaffolding.

---

## 8. Why Epistemic Hygiene Is Scoped by Execution Gear Rather Than Overridden in `AGENTS.md`

### Failure Mode: The Two-Rule Collision in Autonomous Triage

In autonomous dispatch triage, agents face a direct conflict between two instructions:
1. **Epistemic Hygiene in [`rules/AGENTS.md`](../rules/AGENTS.md):**
   *"Never speculate about code, configuration, or behavior you have not opened and read."*
2. **Anti-Micromanagement in [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md):**
   *"The moment remaining investigation is purely linear... the Tech Lead must stop reading code, write the Task Brief, and dispatch the Worker."*

When an LLM prepares a task brief that references an internal function or file, it perceives an unresolvable dilemma:
reading the private implementation feels like micromanagement, but delegating without reading feels like speculating about unread code.
Because LLMs are heavily aligned to avoid hallucination, models default to over-investigating—reading thousands of lines of implementation code across multiple waves before dispatching.

### Why Overriding `AGENTS.md` Directly Fails

Attempting to resolve this tension by modifying [`rules/AGENTS.md`](../rules/AGENTS.md) with conditional exceptions (such as *"the Tech Lead does not read internal code"*) introduces two critical failure modes:
1. **Context pollution across subagents:**
   Harness inspection reveals that subagents (`worker`, `verifier`, `research`) unconditionally inherit the repository's `<user_rules>` and `AGENTS.md` in their prompts.
   Adding delegator-specific disclaimers to `AGENTS.md` pollutes the Worker's context with Tech Lead rules, increasing prompt confusion and rule-bleed across subagent tiers.
2. **Degrading Gear 1 Interactive Pairing:**
   In Gear 1 (interactive pairing), the human developer and agent collaborate directly as Player-Coaches.
   Weakening Epistemic Hygiene in `AGENTS.md` risks creating a lazy, aloof partner that refuses to trace call sites or verify root causes alongside the user.

### The Fix: Harmonious Scoping in `dispatch`

Rather than altering the universal engineering rules in [`rules/AGENTS.md`](../rules/AGENTS.md), [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md) explicitly defines how Epistemic Hygiene is *satisfied* during autonomous task triage:
- Confirming that candidate Core files and module boundaries exist on disk, verifying active human-in-the-loop gates (`rules/`), and ensuring `Open Decisions = 0` fully satisfies Epistemic Hygiene for the triage boundary.
- Proving line-level root causes, tracing private subroutine branches, and authoring test fixtures belong strictly to the Worker's Epistemic Hygiene inside its isolated worktree under [`agents/worker.md`](../agents/worker.md).

### The Pipelining Caveat: Sequential Over Interleaved Waves

Attempting to pipeline investigation across waves (investigating Wave 2 code while Wave 1 Workers run in the background) does not save net execution time and actively pollutes the Tech Lead's context window.
If a Wave 1 Worker triggers a Stop Trigger or encounters a merge collision, an orchestrator saturated with Wave 2 code struggles with context fragmentation.
Triage investigation must remain strictly wave-scoped.
