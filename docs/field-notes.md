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
a fresh, read-only Verifier subagent receives *only* the grounded task brief, `git diff <base>..HEAD`, `Unmandated-call:` trailers, and test output—never the Worker's reasoning.

---

## 2. Why Worktree Isolation Uses Both `PreToolUse` and Git Hooks

Written instructions in `AGENTS.md` telling sessions to work in a linked git worktree were occasionally bypassed during quick fixes—either via direct file-edit tool calls in the root checkout or via `sed -i` shell commands.

**Fix:**
1. `hooks/guard-main-checkout-edits.mjs` intercepts file-edit tools (`edit_file`/`write_file` in Antigravity, `Edit`/`Write` in Claude Code) before the file is touched and returns the exact worktree setup command.
2. `scripts/git-hooks/pre-commit` enforces that the root checkout only accepts merge commits onto `main` (and the initial commit on an unborn repo), while refusing direct edits and non-merge commits. ~~\`scripts/git-hooks/pre-merge-commit\`~~ was removed because verified merges now happen cleanly in the root checkout rather than inside a worktree.
3. Keeping the root checkout attached to `main` as a merge-only trunk allows standard operations (`git pull`, `git status`, `git branch -d`) to work natively without detached-`HEAD` friction, while [`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md) merges into `main` directly in the root checkout.

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
