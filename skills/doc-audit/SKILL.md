---
name: doc-audit
description: >-
  Use in an agent-rig repository when the user invokes /doc-audit, asks to
  "audit docs", "audit documentation", "check doc hygiene", or verify markdown
  graph and backlog consistency. Audits documentation and docs/backlog.md for
  bloat, duplication, stale code claims, ADR rejections, or mixed concerns,
  checks mechanical link and format gates, and updates the last-doc-audit
  tracking stamp.
---

# Documentation Graph & Hygiene Audit (`doc-audit`)

Run both mechanical and semantic checks across the repository's Markdown documentation and [`docs/backlog.md`](../../docs/backlog.md).
<!-- RIG:IF distribution=rig -->
Apply this skill only inside a rigged repository (`rig status` reports `"mode": "attached"` or `"mode": "self-contained"`).
<!-- RIG:ENDIF -->

---

## Step 1 — Mechanical Link & Format Gate

<!-- RIG:IF distribution=rig -->
Run `rig check-docs` and `rig reflow-docs --check`.
<!-- RIG:ELSE -->
Run `node scripts/check-doc-links.mjs` and `node scripts/reflow-docs.mjs --check`.
<!-- RIG:ENDIF -->
Fix any broken relative links, missing `#fragment` anchors, orphaned files under `docs/`, non-existent backticked repo paths, or multi-sentence lines first.

---

## Step 2 — Detect "Two Documents in One File"

Inspect each file under `docs/` (especially ADRs under [`docs/adr/0001-record-architecture-decisions.md`](../../docs/adr/0001-record-architecture-decisions.md)) for mixed lifecycles:
- **Stable invariants & decisions** belong in ADRs or `AGENTS.md`.
- **Chronological implementation diaries** ("Slice 1 did X, Slice 2 changed Y") belong in commit history or `docs/implementation-notes/`, never appended indefinitely to an ADR.

---

## Step 3 — Deduplicate & Ground Docs and Backlog Against Code

1. Search for rules or architectural claims stated in more than one document;
   keep the canonical statement in one place and link to it from the others.
2. Verify every behavioral claim in `README.md`, `AGENTS.md`, and `docs/` against the current implementation files on disk.
3. Audit [`docs/backlog.md`](../../docs/backlog.md) against `docs/adr/` and live code:
   - Remove or move to `Not sanctioned` any item whose proposal was rejected in an ADR under `docs/adr/` (citing the ADR).
   - Prune any item that has already been implemented or made obsolete in the live codebase.
   - Re-validate every remaining item's actionability tier (`Do next`, `Ready, unblocked`, `Gated on an in-flight milestone`, `Needs a decision`, `Waiting on an external trigger`, `Not sanctioned`) so items whose blockers have landed or whose decisions were settled in an ADR are promoted accurately.

---

## Step 4 — Frontmatter Descriptions, Subdirectory Collections & Audit Stamp

1. Ensure permanent documentation files under `docs/` provide a concise, single-sentence frontmatter `description` (`--- ... description: ... ---`) so the generated documentation index in `AGENTS.md` explains each document's purpose without opening it.
2. When a topic directory under `docs/` grows to contain multiple related documents, organize it as a collection by placing a `README.md` with `collection: true` and a `description` in its frontmatter.
   The parent index will emit a single entry pointing to that `README.md`, which automatically maintains its own local documentation index block covering member documents and sub-collections.
3. Update the `<!-- last-doc-audit: YYYY-MM-DD commit=<short-sha> -->` tracking stamp at the top of [`docs/backlog.md`](../../docs/backlog.md) to the current date and `git rev-parse --short HEAD`, then re-run the mechanical linters from Step 1 to confirm a clean pass.

---

## Output Format

Return a documentation audit report using this exact structure:

```markdown
## Documentation Audit Report

- **Mechanical Gate:** PASS | FAIL
- **Link & Anchor Resolution:** PASS | FAIL
- **One Sentence Per Line:** PASS | FAIL
- **Audit Stamp Updated:** `<!-- last-doc-audit: YYYY-MM-DD commit=<short-sha> -->`

### Mixed Lifecycle Findings
- None (or `<file>:<line> — <chronological log mixed into stable decision>`)

### Duplicate Claims
- None (or `<file>:<line> — duplicate claim, canonical in <canonical-file>:<line>`)

### Stale Code Claims, Missing Paths & Backlog Drift
- None (or `<file>:<line> — claims <claim>, but live code at <path> shows <actual>`)

### Remediation & Actions Taken
- `<action taken or proposed>`
```
