# Backlog (`agent-rig`)

Sorted by actionability tier via [`skills/backlog-audit/SKILL.md`](../skills/backlog-audit/SKILL.md).

## Do next

- **Slice 1 — Conditional Markdown hydration (`RIG:IF`) and multi-harness prompt specialization:**
  Governed by [`docs/adr/0003-conditional-markdown-hydration-and-marketplace-bundling.md`](adr/0003-conditional-markdown-hydration-and-marketplace-bundling.md);
  Core files: `bin/rig.mjs`, `tests/cli.test.mjs`, [`rules/AGENTS.md`](../rules/AGENTS.md), [`agents/worker.md`](../agents/worker.md), [`agents/verifier.md`](../agents/verifier.md), [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md), [`skills/rig-onboard/SKILL.md`](../skills/rig-onboard/SKILL.md), [`skills/doc-audit/SKILL.md`](../skills/doc-audit/SKILL.md), [`skills/backlog-audit/SKILL.md`](../skills/backlog-audit/SKILL.md), [`skills/wrap-up/SKILL.md`](../skills/wrap-up/SKILL.md), and [`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md).
  Extend `hydrateText(templateText, resolvedProfile, options)` in `bin/rig.mjs` to evaluate structural HTML-comment conditional blocks (`<!-- RIG:IF key=val1,val2 -->`, `<!-- RIG:ELIF key=val -->`, `<!-- RIG:ELSE -->`, `<!-- RIG:ENDIF -->`, supporting both `=` and `!=` operators) against `{ harness, distribution }` (`distribution` defaults to `"rig"` for `rig install`, `rig update`, and `rig init`, and `"standalone"` for marketplace builds; `harness` is `"antigravity" | "claude" | "codex" | "cursor" | "agensi"`).
  Enforce fail-closed validation in `hydrateText` that throws a descriptive `Error` on unbalanced `RIG:IF` / `RIG:ENDIF` blocks, unknown condition keys (anything outside `harness` and `distribution`), or any leftover `<!-- RIG:` comment in the hydrated output, and collapse `3+` consecutive newlines (`/\n{3,}/g` to `\n\n`) after block evaluation so hydrated Markdown always passes `scripts/reflow-docs.mjs --check`.
  Update the canonical Markdown files to replace "either/or" multi-environment prose with `RIG:IF` blocks:
  in [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md) and [`rules/AGENTS.md`](../rules/AGENTS.md), split worktree setup between `harness=antigravity,claude` (native subagent worktree branching with `git branch -m <type>/<slug>`) and `ELSE` (`git worktree add .worktrees/<slug> -b <type>/<slug>`);
  in [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md) and [`skills/rig-onboard/SKILL.md`](../skills/rig-onboard/SKILL.md), specialize Worker/Verifier subagent invocation for `distribution=rig` vs. `distribution=standalone` (where `./references/worker.md` and `./references/verifier.md` are passed inline in the subagent invocation prompt);
  in [`skills/rig-onboard/SKILL.md`](../skills/rig-onboard/SKILL.md), split Step 2 between `distribution=rig` (`rig init <repo>`) and `distribution=standalone` (creating `.worktrees/rig-init` via `git worktree add .worktrees/rig-init -b chore/rig-init`, adding `.worktrees/` to `.gitignore`, and copying starter templates from [`templates/AGENTS.md`](../templates/AGENTS.md), [`templates/docs/backlog.md`](../templates/docs/backlog.md), and [`templates/docs/adr/0001-record-architecture-decisions.md`](../templates/docs/adr/0001-record-architecture-decisions.md));
  in [`rules/AGENTS.md`](../rules/AGENTS.md), wrap `## CLI Entry Points (rig)` in `<!-- RIG:IF distribution=rig -->`;
  across [`skills/doc-audit/SKILL.md`](../skills/doc-audit/SKILL.md), [`skills/backlog-audit/SKILL.md`](../skills/backlog-audit/SKILL.md), [`skills/wrap-up/SKILL.md`](../skills/wrap-up/SKILL.md), [`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md), [`skills/rig-onboard/SKILL.md`](../skills/rig-onboard/SKILL.md), [`agents/worker.md`](../agents/worker.md), and [`agents/verifier.md`](../agents/verifier.md), split doc-linter commands between `distribution=rig` (`rig check-docs` and `rig reflow-docs --check`) and `distribution=standalone` (`node scripts/check-doc-links.mjs` and `node scripts/reflow-docs.mjs --check`).
  Add unit tests in `tests/cli.test.mjs` covering `RIG:IF` / `RIG:ELIF` / `RIG:ELSE` / `!=` evaluation, newline normalization, and fail-closed errors, and verify with `npm test`.

- **Slice 2 — Zero-maintenance Agensi skill bundler (`build-agensi.mjs`) and package verification test suite (sequenced after Slice 1):**
  Governed by [`docs/adr/0003-conditional-markdown-hydration-and-marketplace-bundling.md`](adr/0003-conditional-markdown-hydration-and-marketplace-bundling.md);
  Core files: `bin/rig.mjs`, `package.json`, `.gitignore`, `scripts/check-doc-links.mjs`, and `scripts/reflow-docs.mjs`;
  Suggested files to create: `build-agensi.mjs` under `scripts/` and `buildAgensi.test.mjs` under `tests/`.
  Functional dependency: sequence after Slice 1 so `hydrateText` in `bin/rig.mjs` already supports `{ harness: "agensi", distribution: "standalone" }` and `<!-- RIG:IF ... -->` conditional blocks.
  Add `dist/` to `.gitignore` and `"build:agensi": "node scripts/build-agensi.mjs"` to `package.json`.
  Implement `build-agensi.mjs` under `scripts/` to build six standalone skill packages into `<outDir>/<slug>/` and `<outDir>/<slug>.zip` (defaulting `<outDir>` to `dist/agensi`):
  five Free SDD & Hygiene skills (`rig-onboard`, `doc-audit`, `backlog-audit`, `wrap-up`, `secure-credential-handoff`) and one Paid Autonomous Execution flagship (`dispatch`, excluding CLI-only `rig-update`).
  For each target skill, `build-agensi.mjs` must:
  hydrate `SKILL.md` via `hydrateText` using `{ harness: "agensi", distribution: "standalone" }` and harness-neutral role descriptors;
  recursively crawl relative Markdown links in hydrated docs so any link pointing to an existing repo doc (`agents/`, `rules/`, `skills/`, [`docs/field-notes.md`](field-notes.md), `docs/adr/`) copies the hydrated target into `<slug>/references/<name>.md` (stripping agent-only `model:` and `tools:` YAML frontmatter keys from files placed in `references/`) and rewrites the link to `./references/<name>.md#fragment`, while links to buyer-repo files (`../../docs/backlog.md`, `../../AGENTS.md`) are unwrapped to inline code (`` `docs/backlog.md` ``, `` `AGENTS.md` ``);
  detect references to `scripts/check-doc-links.mjs` or `scripts/reflow-docs.mjs` and copy those standalone scripts into `<slug>/scripts/`, rewriting `scripts/check-doc-links.mjs` and `scripts/reflow-docs.mjs` invocations to `./scripts/check-doc-links.mjs` and `./scripts/reflow-docs.mjs`;
  for `rig-onboard`, copy hydrated starter templates ([`templates/AGENTS.md`](../templates/AGENTS.md) merged with hydrated [`rules/AGENTS.md`](../rules/AGENTS.md), [`templates/docs/backlog.md`](../templates/docs/backlog.md), and [`templates/docs/adr/0001-record-architecture-decisions.md`](../templates/docs/adr/0001-record-architecture-decisions.md)) into `rig-onboard/templates/` and rewrite template links to `./templates/...`;
  generate a buyer-facing `<slug>/README.md` (with one sentence per line) summarizing the skill's purpose, trigger phrases, and bundled files;
  create `<outDir>/<slug>.zip` containing the single top-level `<slug>/` folder with zero symlinks, hidden OS files, or binary executables;
  and run a built-in verification check on every generated `<slug>/` directory (asserting valid `name` + `description` frontmatter, zero `{{...}}` or `<!-- RIG:` tokens, zero `../` links escaping `<slug>/`, existing targets for every relative link and `./scripts/` or `./templates/` path, and passing one-sentence-per-line formatting).
  Add `buildAgensi.test.mjs` under `tests/` to run the bundler in a temporary directory and verify all six generated skill folders and `.zip` archives during `npm test`.

- **Slice 3 — License transition from `MIT` to `PolyForm-Shield-1.0.0`:**
  Governed by [`docs/adr/0003-conditional-markdown-hydration-and-marketplace-bundling.md`](adr/0003-conditional-markdown-hydration-and-marketplace-bundling.md);
  Core files: `LICENSE`, `package.json`, `.claude-plugin/plugin.json`, `plugin.json`, and `README.md`.
  Replace the `MIT` license text in `LICENSE` with the canonical `PolyForm-Shield-1.0.0` (PolyForm Shield License 1.0.0) text, update the `"license"` field in `package.json`, `.claude-plugin/plugin.json`, and `plugin.json` from `"MIT"` to `"PolyForm-Shield-1.0.0"`, and update any license mention in `README.md` if present.
  Verify with `npm test`.

## Ready, unblocked

- None currently queued.

## Gated on an in-flight milestone

- None currently queued.

## Needs a decision

- **Standalone compiled CLI binary vs. Node runtime dependency:**
  `agent-rig` currently executes via Node.js scripts (`bin/rig.mjs`, harness hooks, and repository scripts) driven by shebangs and runtime wrappers.
  In environments where Node is managed in user-space versions (such as NVM or fnm) without global symlinks on system `PATH`, non-interactive subshells and harness runners fail to resolve `node`.
  Compiling `rig` into a standalone, single-executable binary (in Go, Rust, or via Node SEA / `bun build --compile`) would eliminate host runtime dependencies and shebang resolution fragility.
  Key trade-offs and open questions:
  distribution complexity requires cross-compilation CI pipelines and platform release archives instead of the current lightweight `git pull && rig update` model;
  development velocity favors script-based hooks that allow immediate local edits without compilation steps;
  the threshold for adopting this is whether multi-machine environment heterogeneity or external distribution warrants maintaining a release matrix.

- **Decoupling repository documentation linters from Node in non-Node projects:**
  `rig init --self-contained` vendors `scripts/check-doc-links.mjs` and `scripts/reflow-docs.mjs` into `.rig/scripts/`, while `.rig/hooks/pre-commit` (`rig hook pre-commit`) and `rig check-docs` / `rig reflow-docs` execute those `.mjs` scripts to enforce doc graph invariants.
  In non-JavaScript projects (such as Go, Rust, or Python services), this introduces a Node.js runtime requirement exclusively for documentation checking.
  Key trade-offs and open questions:
  whether target repositories should vendor standalone POSIX shell / compiled linters, or delegate `rig check-docs` to the developer's globally installed `rig` CLI;
  how external contributors and headless CI runners in non-Node repositories run doc verification if verification delegates to the host `rig` CLI;
  whether doc link checking and reflow formatting can be implemented in portable POSIX shell / awk or distributed as tiny static utility binaries.

- **Deterministic Gear 2 orchestrator subcommand (`rig dispatch`) invoked transitively from Gear 1:**
  Under [`docs/adr/0002-two-gear-execution-and-worker-subagent.md`](adr/0002-two-gear-execution-and-worker-subagent.md), Gear 2 autonomous wave execution ([`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md)) currently relies on the host harness's prompt-driven subagent tools to enforce the `Triage -> Worktree -> Worker -> Cold Verifier -> Merge Gate` state machine, the five hard stop triggers in [`agents/worker.md`](../agents/worker.md), and read-only Cold Verifier isolation in [`agents/verifier.md`](../agents/verifier.md).
  Moving the Gear 2 state machine into a native `rig` CLI orchestrator subcommand (`bin/rig.mjs`) would allow the interactive Gear 1 session to stay inside the developer's preferred host harness (Antigravity, Claude Code, Cursor, or Codex) and invoke Gear 2 transitively as a deterministic tool.
  `rig` would manage worktree creation, bind Worker `cwd` roots, enforce modified-file-count caps (Stop Trigger #4) and consecutive test-failure limits (Stop Trigger #5) in code rather than prose, run the Cold Verifier in a clean read-only/test-only context without the Worker's transcript, and pause cleanly in `.worktrees/<slug>` whenever a Stop Trigger fires so the developer and main session can seamlessly downshift to Gear 1 in the same conversation before resuming the wave.
  Key trade-offs and open questions:
  whether Worker and Verifier execution turns inside `rig` should wrap headless host harness CLIs (preserving flat-rate subscription billing), call provider APIs directly (BYOK), or embed a lightweight open-source agent loop;
  how paused Worker contexts are suspended and resumed across interactive Gear 1 interventions when an architectural fork (Stop Trigger #2) is resolved in chat;
  whether deterministic state gates should first land as lightweight `rig` subcommands called by existing harness subagents before building a full headless runner loop.

## Waiting on an external trigger

- **Optional Playwright `browser-driver` plugin/skill:**
  Re-introduce the headless Playwright REPL skill only if Antigravity's native browser tools prove insufficient for deterministic geometry verification in real projects.

## Not sanctioned

- **Single-agent fallback branches inside [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md):**
  Deliberately omitted so subagent-capable harnesses have zero prompt escape hatches to skip the cold Verifier subagent.

- **Custom git wrapper subcommands (`rig pull`, `rig merge`):**
  Rejected to avoid wrapping standard git operations in bespoke CLI abstractions;
  merge orchestration remains in [`skills/merge-to-main/SKILL.md`](../skills/merge-to-main/SKILL.md) using native `git` commands.

## Unranked

- None currently queued.
