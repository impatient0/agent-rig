# ADR 0001: Record Architecture Decisions

## Status

Accepted.

## Context

Architectural decisions and rejected alternatives made during agentic sessions are lost if they remain only in conversation transcripts.

## Decision

We record significant architectural decisions and rejected alternatives as numbered Markdown files under `docs/adr/`, kept under 24,000 bytes per file and linked from [`AGENTS.md`](../../AGENTS.md) or [`docs/backlog.md`](../backlog.md).

## Consequences

Cold sessions can verify why an approach was chosen or rejected before proposing changes.
