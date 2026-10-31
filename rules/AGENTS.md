# Universal Agentic Engineering Rules (`agent-rig`)

## Epistemic Hygiene & Investigation First

Never speculate about code, configuration, or behavior you have not opened and read.
Before proposing a fix, state the root cause and cite the exact file and line that proves it.
If a requirement has genuine ambiguity that changes data structures, public interfaces, or user-visible behavior, stop and ask a brief, direct question before writing code.
Do not gold-plate, add speculative abstractions, or refactor adjacent code outside the task scope.

---

## Session-Per-Worktree Isolation

By default, parallel agent sessions never share a working tree:

1. **Root checkout stays attached to `main` as a merge-only trunk** and is never edited directly.
   `hooks/guard-main-checkout-edits.mjs` blocks direct file edits, and `scripts/git-hooks/pre-commit` ensures only verified merge commits land there.
   Standard operations (`git pull`, `git status`) work natively in the root checkout.
2. **Work happens in a linked git worktree** on a `<type>/<slug>` branch (`feature/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`):
   - When dispatching subagents, spawn each Worker in an isolated worktree using the harness's native worktree-isolation option (or create a worktree under `.worktrees/<slug>`).
   - When working directly in a session, enter a linked worktree via the harness's native worktree tool or `git worktree add .worktrees/<slug> -b <type>/<slug>` before editing any file.
   - If the repository has a `node_modules` directory at the root, symlink it into the worktree (`ln -s ../../node_modules node_modules`) unless the branch modifies dependencies.
     `hooks/guard-symlinked-node-modules.mjs` blocks `npm`/`pnpm`/`yarn`/`bun` installs against a symlinked `node_modules`.
3. **Merging to `main` happens only when requested by the user**, following [`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md).

---

## Subagent-First Delegation (`dispatch`) & Executor != Verifier

When multiple tasks or a multi-slice plan are in play, operate as the **Tech Lead** in the main session:
ground requirements against the codebase, triage, and delegate self-contained implementation slices to isolated Worker subagents rather than executing multi-slice batches inline.
Follow [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md):

1. **Triage (No All-or-Nothing Refusal):**
   Ground candidate items against the codebase and split them into **Bucket 1 (Dispatch Now)** (passes Gate A non-UI and Gate B spec clarity) and **Bucket 2 (Ask User First)**.
   Dispatch Bucket 1 Workers immediately in the background while asking the user the concrete questions for Bucket 2.
2. **Executor != Verifier:**
   An agent that wrote a diff must never be the sole verifier of that diff.
   Before accepting or merging any Worker branch, spawn a fresh, read-only **Verifier** subagent governed by [`agents/verifier.md`](../agents/verifier.md) that receives **only** the grounded task brief, `git diff <base>..HEAD`, `Unmandated-call:` commit trailers, and test output.
3. **Execution Tiers & Subagent Model Selection:**
   Work is structured across four canonical execution tiers governed by the active profile `{{RIG_PROFILE}}`:
   - **`architect`** (`{{MODEL_ARCHITECT}}`, effort `{{EFFORT_ARCHITECT}}`):
     Main session / Tech Lead, triage, backlog auditing ([`skills/backlog-audit/SKILL.md`](../skills/backlog-audit/SKILL.md)), doc auditing ([`skills/doc-audit/SKILL.md`](../skills/doc-audit/SKILL.md)), repo onboarding ([`skills/rig-onboard/SKILL.md`](../skills/rig-onboard/SKILL.md)), session wrap-up ([`skills/wrap-up/SKILL.md`](../skills/wrap-up/SKILL.md)), ADR authoring, and handling Worker stop triggers.
   - **`worker`** (subagent model `{{SUBAGENT_MODEL_WORKER}}`, target `{{MODEL_WORKER}}`, effort `{{EFFORT_WORKER}}`):
     Isolated implementation subagents running in linked worktrees.
   - **`verifier`** (subagent model `{{SUBAGENT_MODEL_VERIFIER}}`, target `{{MODEL_VERIFIER}}`, effort `{{EFFORT_VERIFIER}}`):
     Cold read-only audit subagent governed by [`agents/verifier.md`](../agents/verifier.md).
   - **`utility`** (subagent model `{{SUBAGENT_MODEL_UTILITY}}`, target `{{MODEL_UTILITY}}`, effort `{{EFFORT_UTILITY}}`):
     Fast mechanical procedures ([`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md), [`skills/secure-credential-handoff/SKILL.md`](../skills/secure-credential-handoff/SKILL.md)) and targeted read-only research subagents.
     Whenever launching a subagent, explicitly pass the tier's resolved subagent model argument (`{{SUBAGENT_MODEL_WORKER}}` for Workers, `{{SUBAGENT_MODEL_VERIFIER}}` for Verifiers, `{{SUBAGENT_MODEL_UTILITY}}` for Utility tasks) rather than defaulting to `inherit`.

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
   - Every backticked repo path (`src/...`, `scripts/...`, `bin/...`, `hooks/...`, `skills/...`, `agents/...`) must exist on disk or be struck through (`~~\`scripts/removed.mjs\`~~`) when documenting a deletion.
