---
name: rig-update
description: >-
  Use when updating agent-rig repository assets, hooks, or vendored skills.
  Inspects pending updates, creates an isolated chore/rig-update worktree,
  applies rig update, runs the verification gate, commits, and merges to main.
---

# Autonomous Worktree-Isolated Repository Update (`rig-update`)

When upstream `agent-rig` changes, initialized repositories may receive updated git hooks (`.rig/hooks/`), updated linting scripts, or updated vendored skills in `--self-contained` mode.
To maintain session-per-worktree isolation governed by [`rules/AGENTS.md`](../../rules/AGENTS.md), repository updates never mutate the root checkout directly.
Instead, this procedure inspects pending changes, applies updates inside a dedicated linked worktree on `chore/rig-update`, executes the verification gate, commits, and merges safely into `main`.

---

## Step 1 — Inspect Pending Updates

1. **Check repository status and harness synchronization:**
   Run `rig update` or `rig status` to inspect global harness synchronization and check if the repository has pending `.rig/` or `--self-contained` updates.
   ```bash
   rig status
   ```
2. **Confirm repository cleanliness:**
   Confirm that the root checkout is clean on `main` before beginning an update:
   ```bash
   git status --short
   ```

---

## Step 2 — Create an Isolated Worktree

1. **Create the `chore/rig-update` worktree:**
   Set up an isolated linked worktree from the attached `main` trunk:
   ```bash
   git worktree add .worktrees/rig-update -b chore/rig-update
   ```
2. **Symlink dependencies if present:**
   If the repository has a root `node_modules` directory, symlink it into the worktree:
   ```bash
   ln -s ../../node_modules .worktrees/rig-update/node_modules
   ```

---

## Step 3 — Apply Repository Asset Refresh

1. **Run `rig update` targeting the worktree:**
   Apply the repository asset refresh directly to the isolated worktree:
   ```bash
   rig update --repo .worktrees/rig-update
   ```
   *(For self-contained repositories, this refreshes vendored skills, rules, agents, and hooks inside `.worktrees/rig-update`).*

---

## Step 4 — Run the Verification Gate

1. **Execute project verification inside the worktree:**
   Run the repository's verification gate (such as `npm test`, `rig check-docs`, and `rig reflow-docs --check`) inside `.worktrees/rig-update`:
   ```bash
   cd .worktrees/rig-update && npm test
   ```
2. **Confirm exit status:**
   Confirm that all verification commands and linters exit with code `0`.

---

## Step 5 — Commit and Merge to `main`

1. **Commit changes on `chore/rig-update`:**
   Stage and commit the updated assets inside `.worktrees/rig-update` following Conventional Commits and commit discipline defined in [`rules/AGENTS.md`](../../rules/AGENTS.md):
   ```bash
   git -C .worktrees/rig-update add -A
   git -C .worktrees/rig-update commit -m "chore(rig): update agent-rig repository assets" -m "Unmandated-call: none"
   ```
2. **Merge into `main`:**
   Merge the verified `chore/rig-update` branch into `main` from the attached root checkout following [`skills/merge-to-main/SKILL.md`](../merge-to-main/SKILL.md).
