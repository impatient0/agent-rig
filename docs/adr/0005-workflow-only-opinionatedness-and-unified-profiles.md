---
description: Decouple committed repository rules from machine-specific model profiles, unify built-in presets in templates/profiles.json, and formalize the three repository adoption modes.
---

# ADR 0005: Workflow-Only Opinionatedness, Unified Profile Presets, and Three-Mode Repository Adoption

## Status

Accepted.

## Context

In earlier versions of `agent-rig`, the model catalog and built-in profile definitions were split across two template files (~~`templates/models.json`~~ and ~~`templates/rig-config.default.json`~~), while `ensureRigConfig` in [`bin/rig.mjs`](../../bin/rig.mjs) copied the entire default configuration into `<rigRoot>/.rig.local.json` on first install.
In addition, [`rules/AGENTS.md`](../../rules/AGENTS.md) embedded profile-specific hydration placeholders (`{{RIG_PROFILE}}`, `{{MODEL_*}}`, `{{SUBAGENT_MODEL_*}}`, and `{{EFFORT_*}}`) directly into the demarcated `<!-- AGENT-RIG:START -->` block committed in every initialized repository's `AGENTS.md`.

This produced two operational failure modes across multi-machine and team workflows:
1. **Stale `.rig.local.json` Shadowing Upstream Preset Updates:**
   Because `loadRigConfig` read `.rig.local.json` as a full replacement for ~~`templates/rig-config.default.json`~~, any machine that had previously run `rig install` remained permanently frozen on outdated preset definitions (such as `antigravity-budget` or `gemini-4-argon`) even after upstream `agent-rig` updated its built-in presets.
2. **Cross-Machine and Cross-Developer `AGENTS.md` Ping-Pong Commits:**
   Baking concrete model and profile names into the demarcated block of a repository's committed `AGENTS.md` coupled repository state to a single machine's harness and subscription tier.
   Whenever two machines or teammates using different profiles (e.g., `antigravity-pro` vs. `antigravity-ultra`, or Antigravity vs. Claude Code) ran `rig update --all`, `updateRepo` overwrote `AGENTS.md` back and forth with `chore(rig): update agent-rig repository assets` commits.

## Decision

1. **Principle of Workflow-Only Opinionatedness (Least Opinionatedness Outside Workflow):**
   `agent-rig` is strictly opinionated about **engineering workflow and epistemic invariants** (Investigation First, Session-Per-Worktree Isolation, Two-Gear Execution, `Executor != Verifier`, Human-Gated UI/Contract Boundaries, `Unmandated-call:` commit trailers, and the directed documentation graph), and deliberately **unopinionated about specific models, subscription tiers, harnesses, or developer tools**.
   Committed repository files (`AGENTS.md` and `.rig/`) must never hardcode a developer's personal harness or model subscription profile.
2. **Profile-Agnostic [`rules/AGENTS.md`](../../rules/AGENTS.md) and Hydrated Harness Assets:**
   - Remove `{{RIG_PROFILE}}`, `{{MODEL_*}}`, `{{SUBAGENT_MODEL_*}}`, and `{{EFFORT_*}}` from [`rules/AGENTS.md`](../../rules/AGENTS.md).
   - [`rules/AGENTS.md`](../../rules/AGENTS.md) defines the four canonical execution tiers (`architect`, `worker`, `verifier`, `utility`) and directs agents to pass the resolved subagent model selector from the harness's hydrated subagent definitions ([`agents/worker.md`](../../agents/worker.md), [`agents/verifier.md`](../../agents/verifier.md)), hydrated skills ([`skills/dispatch/SKILL.md`](../../skills/dispatch/SKILL.md), [`skills/wrap-up/SKILL.md`](../../skills/wrap-up/SKILL.md)), or `rig model resolve <role>`.
   - Concrete model and effort tokens remain hydrated in global harness directories (`~/.gemini/config/plugins/agent-rig/`, `~/.claude/`, `~/.codex/`, `~/.cursor/`) and in harness-specific dot-directories (`.gemini/`, `.claude/`, `.codex/`, `.cursor/`) when `--self-contained` mode is explicitly requested.
3. **Unified Preset Catalog (`templates/profiles.json`) and Copy-on-Write Machine Config (`~/.config/agent-rig/config.json`):**
   - Consolidate the model catalog, harness subagent selectors, default active profile mappings, and built-in preset profiles (`antigravity-pro`, `antigravity-ultra`, `claude-pro`, `claude-max`, `codex-default`, `cursor-default`) into a single [`templates/profiles.json`](../../templates/profiles.json) validated by [`templates/profiles.schema.json`](../../templates/profiles.schema.json).
   - Store user-local profile settings in `~/.config/agent-rig/config.json` alongside `~/.config/agent-rig/state.json` (automatically migrating and removing any legacy `<rigRoot>/.rig.local.json`).
   - Built-in preset definitions always resolve directly from [`templates/profiles.json`](../../templates/profiles.json) so any harness pointing to a built-in preset (`rig profile use <preset>`) automatically receives upstream model updates on `rig update`.
   - When a user customizes a role via `rig profile set <role> <model>`, `rig` performs copy-on-write:
     it snapshots all four roles of the active preset into a pinned `<harness>-custom` entry in `~/.config/agent-rig/config.json` and points `activeProfiles[<harness>]` to `<harness>-custom`.
     Running `rig profile use <preset>` switches back to the managed preset and prunes `<harness>-custom`.
4. **Three-Mode Team Repository Adoption (`attached` vs. `self-contained` vs. `stealth`):**
   - **Mode 1 — Attached (`rig init`, default):**
     Commits `AGENTS.md`, `docs/`, `.rig/hooks/pre-commit`, and `.rig/rules/` to git while each developer uses their own global `agent-rig` harness installation and machine-local `~/.config/agent-rig/config.json`.
     Because `AGENTS.md` is profile-agnostic, developers across different harnesses and subscription tiers share the same workflow invariants with zero git conflicts.
   - **Mode 2 — Self-Contained (`rig init --self-contained`):**
     Vendors `.rig/bin/rig.mjs`, `.rig/templates/profiles.json`, `.rig/scripts/`, `.rig/hooks/`, and hydrated harness dot-directories (`.gemini/`, `.claude/`, `.codex/`, `.cursor/`) into the repository so teams or CI runners without a global `agent-rig` installation share an identical out-of-the-box configuration.
   - **Mode 3 — Stealth (`rig init --stealth`):**
     Scaffolds `AGENTS.md`, `docs/`, and `.rig/hooks/pre-commit` locally and excludes them via `.git/info/exclude`, allowing an individual developer to use `agent-rig` inside an unrigged external or team repository with zero tracked git footprint.

## Consequences

- Built-in presets (`antigravity-pro`, `antigravity-ultra`, `claude-pro`, `claude-max`, `codex-default`, `cursor-default`) update automatically when `agent-rig` updates, while custom role overrides (`<harness>-custom`) remain permanently pinned until reset via `rig profile use <preset>`.
- Switching profiles (`rig profile use`) takes effect immediately across all attached repositories on a machine without dirtying or committing `AGENTS.md` in project repositories.
