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

1. **Run the merge without committing:**
   ```bash
   git -C <root> merge --no-commit --no-ff "$BRANCH"
   ```
2. **Conflict Resolution Ownership:**
   If any check fails or merge conflicts occur, abort the merge immediately:
   ```bash
   git -C <root> merge --abort
   ```
   Never edit conflict files or resolve merges in the root checkout;
   the main checkout edit guard refuses code modifications there, and the orchestrator lacks line-level slice context.
   All conflict resolution is owned by the authoring Worker whose incoming branch caused the conflict.
   Task that Worker inside its live worktree to run `git merge main`, resolve conflicting files using its direct domain context of the slice, verify tests, and commit the merge.
   Spawn a fresh Cold Verifier subagent ([`agents/verifier.md`](../../agents/verifier.md)) to audit the resolved branch diff against `main` before re-attempting Step 2.
3. **Verification gate:**
   Once git merges cleanly without conflicts, run the project's full test and documentation verification suite in `<root>` (`npm test`, `rig check-docs`, `rig reflow-docs --check`) on the uncommitted merge state.

---

## Step 3 — Commit and Clean Up

Execute these steps in order, either individually or chained as a single compound command:

```bash
git -C <root> commit -m "Merge branch '$BRANCH' into main" && \
git -C <root> worktree remove <worktree-path> && \
git -C <root> branch -d "$BRANCH"
```

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

---

## Single-Pass Tip Merging for Linear Stacks

When multiple verified worktree branches form a linear ancestry chain or stack, merging the tip branch into `main` in a single pass lands the entire verified stack.
Merging intermediate branches individually is unnecessary because the tip branch already contains all ancestor commits.

1. **Verify stack ancestry:**
   Confirm each branch in the stack is verified and forms a direct ancestry chain (`git merge-base --is-ancestor <ancestor-branch> <tip-branch>`).
2. **Merge the tip branch without committing:**
   ```bash
   git -C <root> merge --no-commit --no-ff "$TIP_BRANCH"
   ```
3. **Verify the merged stack:**
   Run the project's full test and documentation verification suite in `<root>` (`npm test`, `rig check-docs`, `rig reflow-docs --check`) on the uncommitted merge state.
4. **Commit and remove all stack worktrees and branches:**
   Commit the verified merge and clean up all constituent worktrees and branches across the stack in a single compound command:
   ```bash
   git -C <root> commit -m "Merge branch '$TIP_BRANCH' into main" && \
   git -C <root> worktree remove <worktree-path-1> && \
   git -C <root> worktree remove <worktree-path-2> && \
   git -C <root> branch -d "$BRANCH_1" && \
   git -C <root> branch -d "$BRANCH_2"
   ```
   *(Intermediate branch deletions succeed immediately because all commits in the stack are reachable from the new merge commit on `main`).*
