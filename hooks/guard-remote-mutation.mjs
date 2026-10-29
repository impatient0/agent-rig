#!/usr/bin/env node
// PreToolUse shell guard (`run_command` in Antigravity, `Bash` in Claude Code):
// prompts the user before any command that reaches or mutates state outside the
// working tree — a remote host, a shared repository, or the host's scheduled
// tasks. Local commands run unprompted.

import { pathToFileURL } from 'node:url';
import { readHookInput, emitDecision } from './lib/hook-io.mjs';

function stripHeredocs(cmd) {
  const lines = cmd.split('\n');
  const out = [];
  let endToken = null;
  for (const line of lines) {
    if (endToken !== null) {
      if (line.trim() === endToken) endToken = null;
      continue;
    }
    const m = line.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/);
    if (m) endToken = m[1] ?? m[2] ?? m[3];
    out.push(line);
  }
  return out.join('\n');
}

function maskQuotes(s) {
  return s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""');
}

const SEG_START = `(?:^|[;&|]+|\\$\\(|\\b(?:sudo|env|nohup|time|command|exec)\\s+)+\\s*`;
const atSegStart = (body) => new RegExp(`${SEG_START}${body}`, 'm');

const RULES = [
  {
    re: atSegStart(String.raw`(?:ssh|scp|sftp|rsync)\b`),
    reason: 'reaches a remote host over SSH (`ssh` / `scp` / `sftp` / `rsync`)',
  },
  {
    re: atSegStart(String.raw`crontab\s+-(?!l\b)[A-Za-z]*[erir]`),
    reason: 'modifies or removes the user crontab',
  },
  {
    re: atSegStart(String.raw`crontab\s+(?!-)\S`),
    reason: 'installs a new crontab from a file',
  },
  {
    re: atSegStart(String.raw`docker\b[^;&|\n]*(?:-H\b|--host\b|--context\b)`),
    reason: 'targets a remote Docker daemon (`-H` / `--host` / `--context`)',
  },
  {
    re: /\bDOCKER_HOST\s*=/,
    reason: 'sets `DOCKER_HOST` to target a non-default Docker daemon',
  },
  {
    re: atSegStart(String.raw`git\b[^;&|\n]*\bpush\b[^;&|\n]*\b(?:main|master)\b`),
    reason: 'pushes directly to `main` / `master`',
  },
  {
    re: atSegStart(String.raw`git\b[^;&|\n]*\bpush\b[^;&|\n]*(?:--force\b|--force-with-lease\b|--delete\b|(?<!\S)-[A-Za-z]*f|(?<!\S):\S)`),
    reason: 'force-pushes or deletes a remote ref',
  },
  {
    re: atSegStart(String.raw`gh\s+(?!-\S+\s)*(?:pr|issue|release|repo|run|workflow|api|gist|label|secret|variable)\b(?!\s+(?:view|list|status|diff|checks|watch|search|clone)\b)`),
    reason: 'mutates GitHub state via `gh`',
  },
];

export function checkCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const scrubbed = maskQuotes(stripHeredocs(command));
  for (const { re, reason } of RULES) {
    if (re.test(scrubbed)) return reason;
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let parsed;
  try {
    parsed = readHookInput();
  } catch {
    process.exit(0);
  }
  try {
    const reason = checkCommand(parsed.command);
    if (reason) {
      emitDecision(parsed.schema, 'ask', `Remote/shared state guard: command ${reason}. Confirm with the user before running.`);
    } else {
      emitDecision(parsed.schema, 'allow');
    }
  } catch {
    emitDecision(parsed.schema, 'allow');
  }
}
