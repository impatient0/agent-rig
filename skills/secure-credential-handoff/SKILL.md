---
name: secure-credential-handoff
description: >-
  Use when the user invokes /secure-credential-handoff, or when a command
  requires an API token, password, or secret not yet in the environment (e.g.
  "enter API key", "provide secret", "set password"). Guides the user to write
  the secret to a gitignored mode-0600 file so the plaintext credential never
  appears in the chat transcript or command arguments.
---

# Secure Credential Handoff (`secure-credential-handoff`)

Never ask the user to paste a secret, password, or API key into the chat window, and never pass plaintext credentials on a command line where they are recorded in session transcripts.

---

## Procedure

1. **Choose a gitignored env file path** (either `~/.config/<project>/.env.secrets` outside the repo, or a gitignored `.env.local` verified with `git check-ignore -q .env.local`).
2. **Create the empty mode-`0600` file template** with placeholder variable names:
   ```bash
   umask 077 && touch .env.local && chmod 600 .env.local
   ```
3. **Ask the user to populate the file directly** in their editor or terminal, and wait for their confirmation.
4. **Source the file inside subshells without echoing values:**
   ```bash
   set -a && source .env.local && set +a && ./run-command-using-env
   ```
   Never run `cat`, `env`, `printenv`, or `set -x` while secrets are loaded.

---

## Output Format

Return a credential handoff report using this exact structure:

```markdown
## Secure Credential Handoff Report

- **Credential File Path:** `<path>` (e.g. `.env.local` or `~/.config/<project>/.env.secrets`)
- **File Permissions:** `0600` (PASS | FAIL)
- **Gitignore Status:** IGNORED | EXTERNAL (PASS | FAIL)
- **Status:** WAITING FOR USER INPUT | READY

### Required Environment Variables
- `<VAR_NAME_1>`: <description of purpose, e.g. API token>
- `<VAR_NAME_2>`: <description of purpose, e.g. database password>

### Instructions for User
1. Open `<path>` in your editor or terminal.
2. Populate the required variables above with your actual secrets and save the file.
3. Confirm in chat once saved (do NOT paste secret values into chat).

### Subshell Execution Command
- Run commands using: `set -a && source <path> && set +a && <command>`
```
