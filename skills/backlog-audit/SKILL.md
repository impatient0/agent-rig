---
name: backlog-audit
description: >-
  Use when auditing, sorting, or grooming docs/backlog.md. Classifies Unranked
  items into actionability tiers, checks existing ADRs so previously rejected
  ideas are not re-queued, and re-validates existing tiers against codebase
  drift.
---

# Backlog Actionability Audit (`backlog-audit`)

Keep [`docs/backlog.md`](../../docs/backlog.md) sorted by **what blocks execution right now**, rather than subjective priority scores.

---

## Step 1 — ADR Rejection & Already-Done Check

Before placing any item from `Unranked` (or re-validating an existing item):
1. Check `docs/adr/` (starting from [`docs/adr/0001-record-architecture-decisions.md`](../../docs/adr/0001-record-architecture-decisions.md)) to verify the proposal was not already rejected in an ADR.
   - If rejected by an ADR without new superseding evidence, move or delete it with a citation to that ADR.
2. Check the live codebase to verify the item has not already been implemented or made obsolete.

---

## Step 2 — Classify Into Actionability Tiers

Every active item in [`docs/backlog.md`](../../docs/backlog.md) belongs in exactly one of these tiers:

1. **`Do next`** — High-leverage, unblocked, spec-complete items ready for immediate execution or [`skills/dispatch/SKILL.md`](../dispatch/SKILL.md).
2. **`Ready, unblocked`** — Clear scope and acceptance criteria;
   can be picked up by a Worker subagent at any time without human input.
3. **`Gated on an in-flight milestone`** — Clear scope, but blocked until a named feature or refactor lands;
   must state the exact unblocking condition.
4. **`Needs a decision`** — Blocked on an explicit product, UX, or architectural question;
   must state the concrete question to ask the user.
5. **`Waiting on an external trigger`** — Blocked on an upstream release, real-world usage data, or a measured bottleneck;
   must state the trigger metric or event.
6. **`Not sanctioned`** — Recorded so the idea is not forgotten, but explicitly out of scope unless priorities change.

---

## Step 3 — Normalize Format & Verify Links

Run `scripts/reflow-docs.mjs` and `scripts/check-doc-links.mjs` (or `rig reflow-docs` and `rig check-docs`) after editing [`docs/backlog.md`](../../docs/backlog.md).
