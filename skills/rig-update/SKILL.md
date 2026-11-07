---
name: rig-update
description: >-
  Use when updating agent-rig global harness plugins, repository assets, hooks,
  or vendored skills. Inspects pending updates, validates that target
  repositories are clean on main, applies rig update --repo or rig update --all
  with automatic main-branch asset commits, and runs the verification gate.
---

# Global Harness & Clean-Trunk Repository Update (`rig-update`)

When upstream `agent-rig` changes, initialized repositories may have pending updates to `.rig/` (git hooks, vendored CLI, and linting scripts), the demarcated universal rules block in `AGENTS.md`, or vendored harness assets (`.gemini/`, `.claude/`, `.codex/`, `.cursor/`) in `--self-contained` mode.
Because `.rig/hooks/pre-commit` (`rig hook pre-commit`) permits `.rig/`, `AGENTS.md`, vendored harness asset, and legacy ~~`scripts/git-hooks/`~~ deletion commits directly on `main`/`master` in the root checkout (governed by [`rules/AGENTS.md`](../../rules/AGENTS.md)), `rig update --repo <target-dir>` and `rig update --all` validate that the target checkout is clean on `main`/`master` and automatically stage and commit updated repository assets on `main` without manual worktree scaffolding.
In stealth-initialized repositories (`rig init --stealth`), `rig update` refreshes local assets in-place without staging or committing to git, keeping git status completely clean.

---

## Step 1 — Inspect Pending Updates & Cleanliness

1. **Refresh global harnesses and inspect pending repository updates:**
   Run `rig update` (with no repository flags) or `rig status [<target-dir>]` to sync global harness configurations and list any initialized repositories with pending asset updates:
   ```bash
   rig update
   rig status <target-dir>
   ```
2. **Confirm repository cleanliness on `main`:**
   Confirm that the target repository's root checkout is on `main` (or `master`) with a clean working tree:
   ```bash
   git -C <target-dir> status --short
   ```
   *(If a repository is on a non-`main` branch or has uncommitted changes, `rig update --repo` and `rig update --all` safely skip it with a warning rather than mutating disk).*

---

## Step 2 — Apply Repository Asset Refresh on `main`

1. **Run `rig update` for the target repository (or all initialized repositories):**
   ```bash
   # Update a specific clean repository on main:
   rig update --repo <target-dir>

   # Or update all clean initialized repositories on main:
   rig update --all
   ```
   *(This refreshes `.rig/` hooks, the demarcated block in `AGENTS.md`, and any `--self-contained` vendored skills, agents, rules, and hooks, then automatically commits `chore(rig): update agent-rig repository assets` with `Unmandated-call: none` directly on `main`).*
2. **Confirm clean post-update status:**
   Verify that the asset refresh was committed cleanly and no untracked or unstaged changes remain:
   ```bash
   git -C <target-dir> status --short
   git -C <target-dir> log -1
   ```

---

## Step 3 — Run the Verification Gate

1. **Execute project and documentation verification:**
   Run the repository's verification gate and documentation linters on the updated `main` checkout:
   ```bash
   rig check-docs <target-dir>
   rig reflow-docs <target-dir> --check
   ```
   *(If the repository defines a test suite such as `npm test`, run it in `<target-dir>` and confirm exit status `0`).*
