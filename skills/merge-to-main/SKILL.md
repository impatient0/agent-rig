---
name: merge-to-main
description: >-
  Use when the user asks to merge a worktree branch into main. Uses main as a
  natural mutex lock across parallel worktrees, verifies the uncommitted merge
  with the full test suite, commits, and immediately re-detaches HEAD on main.
---

# Safe Worktree Merge to `main` (`merge-to-main`)

Because the repository's root checkout stays parked on a detached `HEAD` at `main`, any linked worktree can temporarily check out `main` to perform a verified merge.
Git refuses to let two worktrees check out `main` simultaneously, making `git switch main` an atomic lock across parallel sessions.

---

## Step 1 — Pre-Flight in the Worktree

1. Confirm you are inside a linked git worktree (`git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`) and the working tree is clean (`git status --short`).
2. Record the worktree branch name (`BRANCH=$(git symbolic-ref --short HEAD)`).
3. Ensure the root checkout is detached (`rig detach` if needed).

---

## Step 2 — Acquire `main` & Test the Uncommitted Merge

1. Run `git switch main` inside the worktree.
2. Run `git merge --no-commit --no-ff "$BRANCH"`.
3. Run the project's full test and documentation verification suite (`npm test`, `rig check-docs`, `rig reflow-docs --check`) on the uncommitted merge state.
   - If any check fails, abort with `git merge --abort && git switch "$BRANCH"` and fix the issue on the branch before retrying.

---

## Step 3 — Commit & Release the `main` Lock Immediately

1. Commit the verified merge (`git commit -m "Merge branch '$BRANCH' into main"` or fast-forward if linear history is requested).
2. **Immediately release `main`** so the root checkout and other worktrees are not blocked:
   ```bash
   git switch --detach main
   ```
3. Update the root checkout's detached `HEAD` to the new `main` tip if clean (`rig detach`), and optionally remove the completed worktree and branch.
