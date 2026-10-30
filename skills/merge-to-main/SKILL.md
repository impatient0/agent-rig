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

## Step 3 — Commit, Advance Root Checkout, and Clean Up

Execute these steps in order, preferably as separate command calls rather than a single compound `&&` chain so file locks settle cleanly:

1. **Commit the verified merge (inside the worktree):**
   ```bash
   git commit -m "Merge branch '$BRANCH' into main"
   ```
   *(Or fast-forward if linear history is requested).*
2. **Release the `main` branch lock in the worktree immediately:**
   ```bash
   git switch --detach main
   ```
3. **Advance the root checkout's detached `HEAD` to the new `main` tip first:**
   Run from the root checkout (or pass `-C <root>`):
   ```bash
   git switch --detach main
   ```
   *(Or run `rig detach <root>`).*
   > [!IMPORTANT] Do this **before** attempting to delete the branch.
   > Git's safe deletion check (`git branch -d`) evaluates reachability relative to the checkout's active `HEAD`.
   > If the root checkout is still at the pre-merge commit, Git will falsely complain that the branch is not fully merged.
4. **Remove the completed worktree safely:**
   ```bash
   git worktree remove <worktree-path>
   ```
   *(Always use `git worktree remove`, never `rm -rf`, so symlinked `node_modules` are not accidentally traversed or deleted).*
5. **Delete the merged feature branch:**
   ```bash
   git branch -d "$BRANCH"
   ```
