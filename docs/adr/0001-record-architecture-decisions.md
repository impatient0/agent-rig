# ADR 0001: Record Architecture Decisions and Dual-Protocol Hook Architecture

## Status

Accepted.

## Context

`agent-rig` must provide a zero-footprint global workflow across Antigravity and Claude Code while remaining usable by generic `AGENTS.md` / `SKILL.md` harnesses, without relying on undocumented heuristics to identify the calling harness.

## Decision

1. **Record architecture decisions in `docs/adr/`:**
   Each ADR is kept under 24,000 bytes and linked from [`AGENTS.md`](../../AGENTS.md) or [`docs/backlog.md`](../backlog.md).
2. **Separate payload schema from harness identity in `hooks/lib/hook-io.mjs`:**
   - Hook manifests pass an explicit `--harness=antigravity` (in `hooks.json`) or `--harness=claude` (in `hooks/claude-hooks.json`) flag to select harness-specific remediation text.
   - Input/output JSON serialization strictly follows each platform's documented `PreToolUse` contract (`toolCall.args` and `{ decision, reason }` for Antigravity; `tool_input` and `{ hookSpecificOutput }` for Claude Code).

## Consequences

- Both Antigravity and Claude Code execute the exact same `hooks/guard-*.mjs` scripts.
- Third-party tools that reuse a documented JSON schema receive a valid response envelope without being misidentified as Claude Code.
