---
description: HTML-comment conditional hydration in canonical Markdown files and zero-maintenance standalone skill bundling under PolyForm Shield.
---

# ADR 0003: Conditional Markdown Hydration and Standalone Marketplace Bundling

## Status

Accepted.

## Context

`agent-rig` targets multiple harnesses (`antigravity`, `claude`, `codex`, `cursor`) as well as standalone skill distribution on third-party marketplaces (such as Agensi `.zip` skill packages).
Previously, [`bin/rig.mjs`](../../bin/rig.mjs) supported only flat `{{VARIABLE}}` placeholder substitution in `hydrateText`, which created two structural tensions:
1. **Multi-Harness "Either/Or" Dead Weight in Prompts:**
   Canonical files in [`skills/dispatch/SKILL.md`](../../skills/dispatch/SKILL.md), [`skills/doc-audit/SKILL.md`](../../skills/doc-audit/SKILL.md), [`skills/wrap-up/SKILL.md`](../../skills/wrap-up/SKILL.md), and [`rules/AGENTS.md`](../../rules/AGENTS.md) had to include branches for every harness and environment simultaneously (such as instructing agents both on native worktree branching via `git branch -m` and manual `git worktree add`, or listing both `rig check-docs` and `scripts/check-doc-links.mjs`).
2. **Standalone Marketplace Packaging Constraints:**
   Standalone skill marketplaces unpack `<skill-slug>.zip` archives containing `SKILL.md`, `README.md`, `references/`, `scripts/`, and `templates/` into a single skill directory, and their automated security scanners reject compiled binaries, symlinks, and scripts that mutate files outside the project directory or alter global system/git configuration (ruling out bundling [`bin/rig.mjs`](../../bin/rig.mjs) or global hook installers inside marketplace zips).
   At the same time, diluting canonical `agent-rig` prompts with CLI-less fallback instructions—or maintaining a separate fork or non-Markdown prompt DSL—would degrade local `agent-rig` ergonomics and bypass direct linting by [`scripts/check-doc-links.mjs`](../../scripts/check-doc-links.mjs) and [`scripts/reflow-docs.mjs`](../../scripts/reflow-docs.mjs).

## Decision

1. **Keep Markdown Files as the Canonical Source of Truth with HTML-Comment Conditionals:**
   - Do not move prompts into non-Markdown template files or treat `skills/`, `agents/`, and `rules/` as generated build artifacts.
   - Extend `hydrateText` in [`bin/rig.mjs`](../../bin/rig.mjs) to evaluate structural HTML-comment conditional blocks (`<!-- RIG:IF key=val1,val2 -->`, `<!-- RIG:ELIF ... -->`, `<!-- RIG:ELSE -->`, `<!-- RIG:ENDIF -->`, including `!=` negation) against `{ harness, distribution }` (`distribution: "rig" | "standalone"`, `harness: "antigravity" | "claude" | "codex" | "cursor" | "agensi"`).
   - Fail closed on unbalanced conditional tags, unknown condition keys, or leftover `<!-- RIG:` comments, and normalize `3+` consecutive blank lines after stripping inactive branches so all hydrated outputs pass [`scripts/reflow-docs.mjs`](../../scripts/reflow-docs.mjs).
2. **Treat Marketplace Packaging as a Zero-Maintenance Build Target:**
   - Split portable skills into a **Free SDD & Hygiene Tier** ([`skills/rig-onboard/SKILL.md`](../../skills/rig-onboard/SKILL.md), [`skills/doc-audit/SKILL.md`](../../skills/doc-audit/SKILL.md), [`skills/backlog-audit/SKILL.md`](../../skills/backlog-audit/SKILL.md), [`skills/wrap-up/SKILL.md`](../../skills/wrap-up/SKILL.md), [`skills/secure-credential-handoff/SKILL.md`](../../skills/secure-credential-handoff/SKILL.md)) and a **Paid Autonomous Execution Flagship** ([`skills/dispatch/SKILL.md`](../../skills/dispatch/SKILL.md), which bundles [`skills/merge-to-main/SKILL.md`](../../skills/merge-to-main/SKILL.md), [`agents/worker.md`](../../agents/worker.md), [`agents/verifier.md`](../../agents/verifier.md), [`rules/ui-change-gate.md`](../../rules/ui-change-gate.md), [`rules/contract-change-gate.md`](../../rules/contract-change-gate.md), [`rules/AGENTS.md`](../../rules/AGENTS.md), and [`docs/field-notes.md`](../field-notes.md) under `references/`), while excluding CLI-only [`skills/rig-update/SKILL.md`](../../skills/rig-update/SKILL.md).
   - Build standalone packages via a link-crawling bundler script under `scripts/` that hydrates files with `{ harness: "agensi", distribution: "standalone" }`, copies linked repo docs into `<slug>/references/`, copies standalone [`scripts/check-doc-links.mjs`](../../scripts/check-doc-links.mjs) and [`scripts/reflow-docs.mjs`](../../scripts/reflow-docs.mjs) into `<slug>/scripts/`, copies starter templates into `rig-onboard/templates/`, and verifies zero broken links or `../` path escapes in `npm test`.
3. **Adopt `PolyForm-Shield-1.0.0` Licensing in the Public Repository:**
   - Keep the repository public as an engineering portfolio piece while licensing under `PolyForm-Shield-1.0.0` so developers may use `agent-rig` freely in their own work without permitting competing commercial redistribution or marketplace resale.

## Consequences

- Every installed harness (`antigravity`, `claude`, `codex`, `cursor`) and every standalone `.zip` package receives only the exact instructions relevant to its runtime environment, with zero dead-weight fallback prose.
- Both conditional branches live side-by-side in canonical Markdown and remain continuously verified by [`scripts/check-doc-links.mjs`](../../scripts/check-doc-links.mjs) and [`scripts/reflow-docs.mjs`](../../scripts/reflow-docs.mjs).
