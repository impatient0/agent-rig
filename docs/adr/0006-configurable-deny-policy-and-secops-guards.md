---
description: Configurable .rig/deny policy with @defaults inheritance, mechanical secret-exposure guard, shared pipeline-aware shell parser, and IaC/remote orchestration guards.
---

# ADR 0006: Configurable `.rig/deny` Policy, Secret-Exposure Guard, and IaC Remote Guards

## Status

Accepted.

## Context

Real-world infrastructure and SecOps repositories (such as SOPS-, Ansible-, Terraform-, Kubernetes-, and rclone-heavy projects) exposed four gaps in `agent-rig`'s mechanical `PreToolUse` layer:

1. **Prompt-Only Secret Hygiene Under Progressive Disclosure:**
   [`skills/secure-credential-handoff/SKILL.md`](../../skills/secure-credential-handoff/SKILL.md) prohibits reading plaintext secrets or echoing credentials into session transcripts, but skills are loaded only on demand.
   Cold sessions and isolated Worker subagents debugging authentication or SOPS failures routinely read `.env` files or run `sops -d` to stdout before activating the skill, permanently recording plaintext credentials in session transcripts.
2. **Higher-Level IaC and Remote Orchestration Bypass:**
   `hooks/guard-remote-mutation.mjs` prompts before low-level remote transports (`ssh`, `scp`, `sftp`, `rsync`, remote `docker`, `crontab`, `git push` to `main`, and mutating `gh` commands), while higher-level CLIs (`ansible`, `ansible-playbook`, `terraform`, `tofu`, `terragrunt`, `kubectl`, `helm`, and `rclone`) reach or mutate live infrastructure unprompted.
3. **Duplicated, Pipe-Blind Shell Tokenization:**
   Shell tokenization and wrapper stripping are duplicated across `hooks/guard-remote-mutation.mjs` and `hooks/guard-symlinked-node-modules.mjs`, and splitting indiscriminately on `|` erases pipeline stage and output-redirection boundaries needed to distinguish terminal stdout leaks (`sops -d secrets.sops.yaml` or `sops -d secrets.sops.yaml | jq .`) from `/dev/null` validation or non-echoing consumers.
4. **Hardcoded Heuristics vs. Stale Pre-Seeded Boilerplate:**
   Hardcoding un-overridable path or command heuristics in hook scripts blocks legitimate repository workflows (such as dummy certificate fixtures in tests or local ephemeral clusters).
   Conversely, copy-seeding dozens of default rules directly into every initialized repository's `.rig/` directory repeats the stale-config failure mode documented in [`docs/adr/0005-workflow-only-opinionatedness-and-unified-profiles.md`](0005-workflow-only-opinionatedness-and-unified-profiles.md), freezing existing repositories on outdated defaults whenever upstream `agent-rig` adds new protections.

## Decision

1. **Shared Pipeline-Aware Shell Parser (`shell-parser.mjs` under `hooks/lib/`):**
   - Extract a single zero-dependency shell parser shared across all shell `PreToolUse` guards.
   - Preserve heredoc stripping, quote-aware tokenization, wrapper and leading assignment stripping (`sudo`, `env`, `nohup`, `time`, `command`, `exec`), recursive subshell extraction (`$(...)` and backticks), nested shell extraction (`bash`/`sh`/`zsh`/`dash -c` and `eval`), stateful `cd <dir>` tracking, command-list splitting (`;`, `&&`, `||`, `\n`), ordered pipeline stages (`|`, `|&`), and per-stage I/O redirections (`<`, `>`, `>>`, `2>&1`, `/dev/null`).
2. **Configurable `.rig/deny` Policy with `@defaults` Inheritance and Last-Match-Wins Precedence (`deny-policy.mjs` under `hooks/lib/` and `deny.default` under `templates/`):**
   - Ship built-in secret path globs, content-inspection rule IDs, shell-leak rule IDs, and remote-guard rule IDs declaratively in `deny.default` under `templates/`.
   - Seed `.rig/deny` during `rig init` and `rig update --repo` (only when `.rig/deny` does not yet exist) with a minimal file containing `@defaults` and usage comments, and ignore `.rig/deny.local` for optional untracked machine-specific rules.
   - Evaluate rules top-to-bottom where the **last matching rule wins** (`.gitignore` semantics):
     - Path and directory globs support `~/` home expansion, basename patterns (such as `.env` and `.env.*`), recursive directory globs (`secrets/**`), and `!pattern` negations.
     - Named rule switches (`@content:<id>`, `@shell:<id>`, `@remote:<id>`) and their negations (`!@content:<id>`, `!@shell:<id>`, `!@remote:<id>`) enable or disable built-in detectors per repository.
   - Resolution across [`docs/adr/0005-workflow-only-opinionatedness-and-unified-profiles.md`](0005-workflow-only-opinionatedness-and-unified-profiles.md) adoption modes:
     - Resolve `<repoRoot>/.rig/deny` via `hooks/lib/hook-io.mjs` (`resolveGitRoots`) so untracked `.rig/deny` in `--stealth` repositories applies across linked `.worktrees/*`, layered with worktree-local `.rig/deny` (if modified on a branch) and optional `.rig/deny.local`.
     - If no `.rig/deny` file exists, evaluate `@defaults`;
       if `.rig/deny` exists and omits `@defaults`, start from an empty rule set ("blank slate").
     - Manually configured deny globs take strict positional priority and are never overridden by ciphertext or public-certificate heuristics unless explicitly negated later in `.rig/deny` via `!pattern`.
3. **Hardcoded Anti-Tamper Self-Protection of `.rig/deny` and `.rig/deny.local`:**
   - Humans may edit or delete any rule (including `@defaults`) in `.rig/deny` or `.rig/deny.local` directly in their editor or terminal.
   - Agent tool calls (`edit_file`, `write_file`, `Edit`, `Write`, and shell write/in-place-edit/delete commands in `run_command` / `Bash`) targeting `.rig/deny` or `.rig/deny.local` in any rigged root checkout or linked worktree are unconditionally refused (`decision: "deny"`).
4. **Cross-Harness Secret-Exposure Guard (`guard-secret-exposure.mjs` under `hooks/`):**
   - Explicitly scope as an **accidental-leak and transcript-hygiene guardrail** rather than a sandbox against arbitrary `python` or `node` code execution.
   - Gate hook activation under [`docs/adr/0004-strict-unrigged-repository-isolation.md`](0004-strict-unrigged-repository-isolation.md) on `isDirectoryInRiggedRepo(cwd) || (targetPath && isDirectoryInRiggedRepo(targetPath))` so rigged sessions cannot read host credential stores in `$HOME`, while unrigged sessions experience zero interference.
   - Default path globs in `@defaults` deny host credential stores (`~/.ssh/id_*`, `~/.gnupg/**`, `~/.aws/credentials`, `~/.config/sops/age/**`, `~/.kube/config`, `~/.config/rclone/rclone.conf`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.docker/config.json`, `~/.config/gh/hosts.yml`) and sensitive files anywhere (`.env`, `.env.*`, `*.key`, `*.p12`, `*.pfx`, `*.agekey`, `*.tfstate`, `*.tfstate.*`, `*vault_pass*`), while exempting public keys (`!*.pub`), safe templates (`!*.example`, `!*.sample`, `!*.template`, `!*.dist`, `!*.schema`), and SOPS/encrypted filenames (`!*.sops.*`, `!*.enc.*`).
   - Default `@content:*` rules inspect local file headers inside the hook process without emitting file contents:
     - `@content:private-key` denies files containing `-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----` while allowing pure public `CERTIFICATE` `.pem`/`.crt` files.
     - `@content:unencrypted-sops` denies existing `*.sops.*` and `*.enc.*` files on disk that lack SOPS (`ENC[`) or `$ANSIBLE_VAULT;` ciphertext markers.
     - `@content:npmrc-auth` denies project `.npmrc` files containing `_authToken`, `_auth=`, or `_password`.
   - Default `@shell:*` rules guard `run_command` / `Bash`:
     - `@shell:file-read` denies direct stdout readers and filters (`cat`, `head`, `tail`, `less`, `more`, `bat`, `nl`, `grep`/`rg` without `-q`/`--quiet`, `sed`, `awk`, `cut`, `strings`, `base64`, `xxd`, `jq`, `yq`, and `<` input redirection) on `.rig/deny`-matched paths, while allowing `grep -q` / `rg -q` for zero-stdout key checks.
     - `@shell:sops-decrypt` allows `sops -d`/`--decrypt`/`decrypt` and `ansible-vault view|decrypt` when redirected to `/dev/null`, returns `deny` when writing to terminal stdout or piped into text/JSON printers (`cat`, `head`, `tail`, `grep`, `rg`, `sed`, `awk`, `jq`, `yq`, `tee`), and returns `ask` when piped into a non-echoing consumer or redirected to a file (pointing to `sops exec-env` / `sops exec-file` in [`skills/secure-credential-handoff/SKILL.md`](../../skills/secure-credential-handoff/SKILL.md)).
     - `@shell:env-dump` denies bare `env` (when not wrapping a command), bare `printenv` (or `printenv` targeting secret-like variable names), `export -p`, `declare -xp`, `set` with no arguments, and `set -x` / `set -o xtrace` / `bash -x` in chains that `source` or `.` a `.rig/deny`-matched file.
     - `@shell:cli-secret-dump` denies `rclone config show|dump`, `kubectl get secret|secrets` with value-bearing `-o` formats (`yaml`, `json`, `jsonpath*`, `go-template*`, `custom-columns*`), `kubectl config view --raw`, and `terraform`/`tofu` `state pull` or `output` with `-json`/`-raw`.
   - Extend `hooks/lib/hook-io.mjs` (`parseHookInput`) to normalize read and search tool arguments across Antigravity (`read_file`, `view_file`, `view_file_outline`, `view_code_item`, `grep_search`) and Claude Code (`Read`, `Grep`), allowing directory-level `Grep` on repository roots while denying searches targeting denied files/directories or secret-matching `glob`/`Includes` filters.
5. **Token-Aware IaC & Remote Orchestration Guards in `hooks/guard-remote-mutation.mjs`:**
   - Parse leading global flags (including `terraform -chdir=<dir>` shifting `activeCwd`, `kubectl --context ... -n ...`, and `helm -n ...`) and return `decision: "ask"` inside rigged repositories when controlled `@remote:*` switches are active in `.rig/deny`:
     - `@remote:ansible` — prompts `ask` on `ansible` and `ansible-playbook` unless purely local/offline flags (`--syntax-check`, `--version`, `--help`, `-h`, `--list-tasks`, `--list-tags`, `--list-hosts`) are passed (`--check` remains `ask` because it connects over SSH).
     - `@remote:terraform` and `@remote:terraform-plan` — prompt `ask` on `terraform`, `tofu`, and `terragrunt` mutations (`apply`, `destroy`, `import`, `taint`, `untaint`, `force-unlock`, `console`, `workspace new|delete|select`, `state rm|mv|push|replace-provider`, `run-all ...`) under `@remote:terraform` and live `plan` under `@remote:terraform-plan`, while allowing offline commands (`validate`, `fmt`, `version`, `providers`, `init -backend=false`, `--help`).
     - `@remote:kubectl`, `@remote:kubectl-read`, `@remote:helm`, and `@remote:helm-read` — allow offline client invocations (`--dry-run=client`, `kubectl version --client`, `kubectl config current-context|get-contexts|get-clusters|view`, `helm lint|template|show|inspect|search|version|env`, `--help`), prompt `ask` on live read-only cluster queries under `@remote:kubectl-read` / `@remote:helm-read`, and prompt `ask` on all other cluster/release mutations, `exec`, `cp`, `port-forward`, `drain`, `rollout`, `install`, `upgrade`, `uninstall`, and `rollback` under `@remote:kubectl` / `@remote:helm`.
     - `@remote:rclone` and `@remote:rclone-read` — detect both `<remote>:` and leading-colon `:backend:` specs, allowing local-only invocations and `version`/`--version`/`help`/`listremotes`/`obscure`, prompting `ask` on remote read-only listings (`ls`, `lsd`, `lsf`, `lsl`, `stat`, `size`, `about`, `check`) under `@remote:rclone-read`, and prompting `ask` on remote transfers, mounts, and mutations under `@remote:rclone`.

## Consequences

- Repositories keeping `@defaults` in `.rig/deny` automatically receive upstream secret and remote-guard improvements on `rig update` without local config drift, while retaining full per-repository override or blank-slate deletion control.
- Plaintext credentials, SOPS age keys, SSH private keys, and `.tfstate` secrets are mechanically blocked from entering transcripts across file-read, search, and shell tools, while `sops exec-env`, `sops exec-file`, encrypted SOPS schema inspection, and offline IaC validation remain frictionless.
