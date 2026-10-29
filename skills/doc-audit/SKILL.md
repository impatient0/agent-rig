---
name: doc-audit
description: >-
  Use when auditing documentation for bloat, duplication, stale code claims, or
  mixed concerns. Identifies files that mix stable architectural decisions with
  chronological slice logs, finds duplicated claims across docs, and verifies
  cited paths against live code.
---

# Documentation Graph & Hygiene Audit (`doc-audit`)

Run both mechanical and semantic checks across the repository's Markdown documentation.

---

## Step 1 — Mechanical Link & Format Gate

Run `scripts/check-doc-links.mjs` and `scripts/reflow-docs.mjs --check` (or `rig check-docs` and `rig reflow-docs --check`).
Fix any broken relative links, missing `#fragment` anchors, orphaned files under `docs/`, non-existent backticked repo paths, or multi-sentence lines first.

---

## Step 2 — Detect "Two Documents in One File"

Inspect each file under `docs/` (especially ADRs under [`docs/adr/0001-record-architecture-decisions.md`](../../docs/adr/0001-record-architecture-decisions.md)) for mixed lifecycles:
- **Stable invariants & decisions** belong in ADRs or `AGENTS.md`.
- **Chronological implementation diaries** ("Slice 1 did X, Slice 2 changed Y") belong in commit history or `docs/implementation-notes/`, never appended indefinitely to an ADR.

---

## Step 3 — Deduplicate & Ground Against Code

1. Search for rules or architectural claims stated in more than one document;
   keep the canonical statement in one place and link to it from the others.
2. Verify every behavioral claim in `README.md`, `AGENTS.md`, and `docs/` against the current implementation files on disk.
