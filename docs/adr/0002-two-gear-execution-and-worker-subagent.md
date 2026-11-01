# ADR 0002: Two-Gear Execution Model and Isolated Worker Subagent

## Status

Accepted.

## Context

`agent-rig` enforces strict separation between execution and verification (`Executor != Verifier`).
However, the original triage pipeline suffered from an operational tension between two failure modes:
1. **The Double-Read Tax:**
   Requiring the Tech Lead to prove line-level root cause before delegating forced the architect tier to solve 85% of a task during triage, only for the Worker subagent to re-read the exact same files from scratch in a fresh context.
2. **The "Manager Who Stopped Coding" Syndrome:**
   Attempting to resolve the tax by mandating subagent delegation for all prompts ($N=1$) alienated the human developer from the code, degraded mechanical sympathy, and turned the Tech Lead into an aloof manager.
3. **Completion Bias in Heuristic Boundaries:**
   Letting models choose whether to delegate based on perceived task size failed because models systematically rationalize executing inline once a file is in context.

## Decision

1. **User-Selected Two-Gear Execution Model:**
   - **Gear 1 — Interactive Pairing (Default Mode):**
     The main session operates as a hands-on Player-Coach, inspecting code deeply with the user and writing diffs directly in a linked git worktree.
     Before completing a slice, it must spawn a fresh Cold Verifier subagent governed by [`agents/verifier.md`](../../agents/verifier.md) (`Executor != Verifier`).
   - **Gear 2 — Autonomous Dispatch ([`skills/dispatch/SKILL.md`](../../skills/dispatch/SKILL.md)):**
     Triggered explicitly by the user (`/dispatch` or backlog sweep).
     The main session operates as a Tech Lead Orchestrator, exploring code only until the `Open Decisions = 0` boundary, naming Core files in the Task Brief, and delegating execution to isolated Worker subagents.
2. **Dedicated Worker Subagent Definition ([`agents/worker.md`](../../agents/worker.md)):**
   - Owns implementation-level epistemic hygiene, line tracing, and the five hard stop triggers.
   - Clarifies that contractual, schema, or public interface choices require Stop Trigger #2 and cannot be resolved via `Unmandated-call:` commit trailers.
3. **Generalized Human-Gated Boundaries (UI & Domain Contracts):**
   - Human-in-the-loop gates are standardized as modular, opt-in rules under `rules/` ([`rules/ui-change-gate.md`](../../rules/ui-change-gate.md), [`rules/contract-change-gate.md`](../../rules/contract-change-gate.md)).
   - Stop Trigger #1 and Verifier Check 3 reference active gates generically.

## Consequences

- The developer and main session maintain intimate code familiarity during interactive pairing while retaining strict verification rigor.
- Autonomous dispatch avoids the double-read tax without dumping ambiguous tasks on Workers.
- The `Executor != Verifier` invariant and session-per-worktree isolation remain universally enforced across all tasks.
