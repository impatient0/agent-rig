# Project Context (`agent-rig`)

`agent-rig` is a subagent-first, platform-agnostic agentic workflow rig providing multi-protocol `PreToolUse` guards, Triage/Worker/Verifier task dispatch, git worktree isolation locks, and documentation graph linters.

- **Test and verification gate** — `npm test` (runs `node --test tests/*.test.mjs`, `scripts/check-doc-links.mjs`, and `scripts/reflow-docs.mjs --check`)
- **CLI entry point** — `bin/rig.mjs` (`rig install`, `rig update`, `rig init`, `rig detach`, `rig check-docs`, `rig reflow-docs`, `rig status`)
- **Architecture and empirical rationale** — [`docs/field-notes.md`](docs/field-notes.md) and [`docs/adr/0001-record-architecture-decisions.md`](docs/adr/0001-record-architecture-decisions.md)
- **Active backlog** — [`docs/backlog.md`](docs/backlog.md)

---

## Rules, Subagents & Skills Index

- **Universal Engineering Rules** — [`rules/AGENTS.md`](rules/AGENTS.md)
- **Human-in-the-Loop UI Gate** — [`rules/ui-change-gate.md`](rules/ui-change-gate.md)
- **Cold Verifier Subagent** — [`agents/verifier.md`](agents/verifier.md)
- **Skills (`skills/`):**
  - [`skills/dispatch/SKILL.md`](skills/dispatch/SKILL.md) — Triage → Isolated Worker → Cold Verifier execution pipeline
  - [`skills/wrap-up/SKILL.md`](skills/wrap-up/SKILL.md) — End-of-session audit, decision routing, and reachability check
  - [`skills/backlog-audit/SKILL.md`](skills/backlog-audit/SKILL.md) — Actionability tiering and ADR-rejection check for [`docs/backlog.md`](docs/backlog.md)
  - [`skills/doc-audit/SKILL.md`](skills/doc-audit/SKILL.md) — Token-budget, duplication, and code-grounding audit for Markdown docs
  - [`skills/merge-to-main/SKILL.md`](skills/merge-to-main/SKILL.md) — Worktree merge procedure using `main` as a mutex lock
  - [`skills/secure-credential-handoff/SKILL.md`](skills/secure-credential-handoff/SKILL.md) — Mode-`0600` secret handoff for non-interactive shell calls
