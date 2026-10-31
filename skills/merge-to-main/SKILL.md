---
name: merge-to-main
description: >-
  Use when the user asks to merge a worktree branch into main. Merges a worktree
  branch into main from the attached root checkout, verifies the uncommitted
  merge with the full test suite, commits, and removes the worktree.
---

# Safe Worktree Merge to `main` (`merge-to-main`)

Because the repository's root checkout stays attached to `main` as a merge-only trunk, verified merges land directly in the root checkout while feature work stays isolated in linked worktrees.

---

## Step 1 — Pre-Flight

1. **Inside the worktree:**
   Confirm the working tree is clean (`git status --short`) and record the branch name (`BRANCH=$(git symbolic-ref --short HEAD)`).
2. **Inside the root checkout:**
   Confirm you are on `main` (`git -C <root> symbolic-ref --short HEAD`), the working tree is clean (`git -C <root> status --short`), and no unresolved merge is in progress (`test ! -f "<root>/.git/MERGE_HEAD"`). *(If another session is mid-merge, stop and report rather than stacking merges).*
3. **Optional remote pull:**
   If a remote tracking branch is configured, fast-forward `main` first (`git -C <root> pull --ff-only`).

---

## Step 2 — Test the Uncommitted Merge in the Root Checkout

1. Run the merge without committing:
   ```bash
   git -C <root> merge --no-commit --no-ff "$BRANCH"
   ```
2. Run the project's full test and documentation verification suite in `<root>` (`npm test`, `rig check-docs`, `rig reflow-docs --check`) on the uncommitted merge state.
3. If any check fails or merge conflicts occur:
   Abort the merge immediately:
   ```bash
   git -C <root> merge --abort
   ```
   Resolve the failure or conflict **inside the worktree** on `$BRANCH` (for example by merging or rebasing `main` into `$BRANCH` within the worktree), verify there, and retry. *(Never edit conflict files or resolve merges in the root checkout; the edit guard refuses modifications there).*

---

## Step 3 — Commit and Clean Up

Execute these steps in order, preferably as separate command calls rather than a single compound `&&` chain so file locks settle cleanly:

1. **Commit the verified merge in the root checkout:**
   ```bash
   git -C <root> commit -m "Merge branch '$BRANCH' into main"
   ```
2. **Remove the completed worktree safely:**
   ```bash
   git -C <root> worktree remove <worktree-path>
   ```
   *(Always use `git worktree remove`, never `rm -rf`, so symlinked `node_modules` are not accidentally traversed or deleted).*
3. **Delete the merged feature branch:**
   ```bash
   git -C <root> branch -d "$BRANCH"
   ```
   *(Safe branch deletion now succeeds immediately because the root checkout's active `HEAD` is already at the new merge commit).*
