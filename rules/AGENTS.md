# Universal Agentic Engineering Rules (`agent-rig`)

## Epistemic Hygiene & Investigation First

Never speculate about code, configuration, or behavior you have not opened and read.
Before proposing a fix, state the root cause and cite the exact file and line that proves it.
If a requirement has genuine ambiguity that changes data structures, public interfaces, or user-visible behavior, stop and ask a brief, direct question before writing code.
Do not gold-plate, add speculative abstractions, or refactor adjacent code outside the task scope.

---

## Session-Per-Worktree Isolation

By default, parallel agent sessions never share a working tree:

1. **Root checkout stays parked on a detached `HEAD` at `main`** (`rig detach` or `git switch --detach main`) and is never edited directly.
   `hooks/guard-main-checkout-edits.mjs` and `scripts/git-hooks/pre-commit` enforce this mechanically.
2. **Work happens in a linked git worktree** on a `<type>/<slug>` branch (`feature/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`):
   - When dispatching subagents, spawn each Worker in an isolated worktree (`Workspace: "share"` in Antigravity; `isolation: "worktree"` in Claude Code).
   - When working directly in a session, create a worktree via `git worktree add .worktrees/<slug> -b <type>/<slug>` (or `EnterWorktree` in Claude Code) before editing any file.
   - If the repository has a `node_modules` directory at the root, symlink it into the worktree (`ln -s ../../node_modules node_modules`) unless the branch modifies dependencies.
     `hooks/guard-symlinked-node-modules.mjs` blocks `npm`/`pnpm`/`yarn`/`bun` installs against a symlinked `node_modules`.
3. **Merging to `main` happens only when requested by the user**, following [`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md).

---

## Subagent-First Delegation (`dispatch`) & Executor != Verifier

When given a backlog sweep or a multi-step implementation task, use [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md):

1. **Triage (No All-or-Nothing Refusal):**
   Ground candidate items against the codebase and split them into **Bucket 1 (Dispatch Now)** (passes Gate A non-UI and Gate B spec clarity) and **Bucket 2 (Ask User First)**.
   Dispatch Bucket 1 Workers immediately in the background while asking the user the concrete questions for Bucket 2.
2. **Executor != Verifier:**
   An agent that wrote a diff must never be the sole verifier of that diff.
   Before accepting or merging any Worker branch, spawn a fresh, read-only **Verifier** subagent (`research` in Antigravity; `Explore` in Claude Code) that receives **only** the grounded task brief, `git diff <base>..HEAD`, `Unmandated-call:` commit trailers, and test output.

---

## Commit Discipline & Attribution Trailers

- Use Conventional Commits (`feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `test: ...`, `chore: ...`).
- Keep commits atomic: one logical slice per commit, with tests passing before commit.
- On delegated or autonomous slices, every commit message must carry one `Unmandated-call: <choice> — <rationale> (<file>:<line>)` trailer per judgment call not explicitly specified in the brief, or `Unmandated-call: none` if zero unmandated choices were made.

---

## Documentation Graph Rules

Every Markdown file in a rigged repository follows two mechanical invariants enforced by `scripts/check-doc-links.mjs` and `scripts/reflow-docs.mjs`:

1. **One sentence per line:**
   Do not hard-wrap mid-sentence or put multiple sentences on one line.
2. **Resolved, reachable link graph:**
   - Every relative link and `#fragment` heading anchor must resolve.
   - Cross-references to repo docs must use standard Markdown links, never wiki-style brackets, wildcard globs, or bare backticked doc paths.
   - Every file under `docs/` must be reachable from `README.md`, `AGENTS.md`, `CLAUDE.md`, a `SKILL.md` file under `skills/`, or a rule file under `rules/`.
   - Every backticked repo path (`src/...`, `scripts/...`, `bin/...`, `hooks/...`, `skills/...`) must exist on disk or be struck through (`~~\`scripts/removed.mjs\`~~`) when documenting a deletion.
