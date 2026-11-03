#!/usr/bin/env node
// PreToolUse shell guard (`run_command` in Antigravity, `Bash` in Claude Code):
// prompts the user before any command that reaches or mutates state outside the
// working tree — a remote host, a shared repository, or the host's scheduled
// tasks. Local commands run unprompted.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
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

function tokenize(seg) {
  const tokens = [];
  const re = /'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec']);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function stripWrappers(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (ASSIGN_RE.test(t) || WRAPPERS.has(t)) {
      i++;
      continue;
    }
    break;
  }
  return { bin: tokens[i] ? path.basename(tokens[i]) : null, rest: tokens.slice(i + 1) };
}

function parseCdSegment(seg) {
  const { bin, rest } = stripWrappers(tokenize(seg));
  if (bin !== 'cd') return null;
  for (const tok of rest) {
    if (tok.startsWith('-')) continue;
    return tok;
  }
  return null;
}

function parseNestedCommand(seg) {
  const { bin, rest } = stripWrappers(tokenize(seg));
  if (!bin) return null;
  if (bin === 'bash' || bin === 'sh' || bin === 'zsh' || bin === 'dash') {
    for (let j = 0; j < rest.length - 1; j++) {
      if (rest[j] === '-c') return rest[j + 1];
    }
    return null;
  }
  if (bin === 'eval' && rest.length > 0) {
    return rest.join(' ');
  }
  return null;
}

function splitSegments(cmd) {
  const masked = cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (m) => ' '.repeat(m.length));
  const cuts = [0];
  const sepRe = /[;&|\n]+/g;
  let m;
  while ((m = sepRe.exec(masked)) !== null) {
    cuts.push(m.index, m.index + m[0].length);
  }
  cuts.push(cmd.length);
  const segs = [];
  for (let i = 0; i < cuts.length; i += 2) {
    const s = cmd.slice(cuts[i], cuts[i + 1]).trim();
    if (s) segs.push(s);
  }
  return segs;
}

function extractSubshells(str) {
  const subshells = [];
  let i = 0;
  let inDoubleQuote = false;

  while (i < str.length) {
    const ch = str[i];

    if (!inDoubleQuote && ch === "'") {
      i++;
      while (i < str.length && str[i] !== "'") {
        i++;
      }
      if (i < str.length) i++;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = !inDoubleQuote;
      i++;
      continue;
    }

    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (ch === '$' && str[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      const start = j;
      let innerInDoubleQuote = false;

      while (j < str.length && depth > 0) {
        const c = str[j];

        if (!innerInDoubleQuote && c === "'") {
          j++;
          while (j < str.length && str[j] !== "'") j++;
          if (j < str.length) j++;
          continue;
        }

        if (c === '"') {
          innerInDoubleQuote = !innerInDoubleQuote;
          j++;
          continue;
        }

        if (c === '\\') {
          j += 2;
          continue;
        }

        if (c === '(') {
          depth++;
        } else if (c === ')') {
          depth--;
          if (depth === 0) {
            break;
          }
        }
        j++;
      }

      subshells.push(str.slice(start, j));
      i = j + 1;
      continue;
    }

    if (ch === '`') {
      let j = i + 1;
      const start = j;
      while (j < str.length) {
        if (str[j] === '\\') {
          j += 2;
          continue;
        }
        if (str[j] === '`') {
          break;
        }
        j++;
      }
      subshells.push(str.slice(start, j));
      i = j + 1;
      continue;
    }

    i++;
  }

  return subshells;
}

function getCurrentBranch(cwd) {
  try {
    const res = spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status === 0 && typeof res.stdout === 'string') {
      return res.stdout.trim();
    }
  } catch {
    // Ignore spawn errors
  }
  return null;
}

const PUSH_FLAGS_WITH_ARG = new Set([
  '--repo',
  '-o',
  '--push-option',
  '--receive-pack',
  '--exec',
]);

function checkGitPush(seg, cwd) {
  const tokens = tokenize(seg);
  const { bin, rest } = stripWrappers(tokens);
  if (bin !== 'git') return null;

  let activeCwd = cwd;
  let pushIdx = -1;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '-C' && i + 1 < rest.length) {
      activeCwd = path.resolve(activeCwd, rest[i + 1]);
      i++;
      continue;
    }
    if (tok.startsWith('-C') && tok.length > 2) {
      activeCwd = path.resolve(activeCwd, tok.slice(2));
      continue;
    }
    if (tok === 'push') {
      pushIdx = i;
      break;
    }
    if (!tok.startsWith('-')) {
      return null;
    }
  }

  if (pushIdx === -1) return null;

  const pushArgs = rest.slice(pushIdx + 1);
  let isForce = false;
  let isMainMaster = false;
  const positional = [];

  for (let j = 0; j < pushArgs.length; j++) {
    const arg = pushArgs[j];
    if (arg === '--') {
      positional.push(...pushArgs.slice(j + 1));
      break;
    }
    if (arg.startsWith('-')) {
      if (PUSH_FLAGS_WITH_ARG.has(arg)) {
        j++;
        continue;
      }
      if (
        arg === '--force' ||
        arg === '--force-with-lease' ||
        arg.startsWith('--force-with-lease=') ||
        arg === '--force-if-includes' ||
        arg === '--delete' ||
        arg === '-d' ||
        (!arg.startsWith('--') && arg.includes('f'))
      ) {
        isForce = true;
      }
      continue;
    }
    positional.push(arg);
  }

  for (let k = 0; k < positional.length; k++) {
    const pos = positional[k];
    if (pos.startsWith('+') || pos.startsWith(':')) {
      isForce = true;
    }
    const target = pos.includes(':') ? pos.slice(pos.indexOf(':') + 1) : pos;
    const cleanTarget = target.startsWith('+') ? target.slice(1) : target;
    if (cleanTarget === 'main' || cleanTarget === 'master') {
      isMainMaster = true;
    }
  }

  if (isMainMaster) {
    return 'pushes directly to `main` / `master`';
  }
  if (isForce) {
    return 'force-pushes or deletes a remote ref';
  }

  if (positional.length === 0 || (positional.length === 1 && !positional[0].startsWith('+') && !positional[0].includes(':'))) {
    const branch = getCurrentBranch(activeCwd);
    if (branch === 'main' || branch === 'master') {
      return 'pushes directly to `main` / `master`';
    }
  }

  return null;
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
    re: atSegStart(String.raw`git\b[^;&|\n]*\bpush\b[^;&|\n]*(?:--force\b|--force-with-lease\b|--delete\b|(?<!\S)-[A-Za-z]*f|(?<!\S):\S|(?<!\S)\+\S)`),
    reason: 'force-pushes or deletes a remote ref',
  },
  {
    re: atSegStart(String.raw`gh\s+(?!-\S+\s)*(?:pr|issue|release|repo|run|workflow|api|gist|label|secret|variable)\b(?!\s+(?:view|list|status|diff|checks|watch|search|clone)\b)`),
    reason: 'mutates GitHub state via `gh`',
  },
];

export function checkCommand(command, cwd = process.cwd(), _depth = 0) {
  if (typeof command !== 'string' || !command.trim() || _depth > 10) return null;

  const stripped = stripHeredocs(command);

  // 1. Check extracted subshells ($( ... ) and ` ... `) recursively
  const subshells = extractSubshells(stripped);
  for (const sub of subshells) {
    const reason = checkCommand(sub, cwd, _depth + 1);
    if (reason) return reason;
  }

  // 2. Check top-level / scrubbed command against RULES
  const scrubbed = maskQuotes(stripped);
  for (const { re, reason } of RULES) {
    if (re.test(scrubbed)) return reason;
  }

  // 3. Split into segments (by ; && || | \n) and inspect each segment
  let activeCwd = cwd;
  const segs = splitSegments(stripped);
  for (const seg of segs) {
    const cdTarget = parseCdSegment(seg);
    if (cdTarget) {
      activeCwd = path.resolve(activeCwd, cdTarget);
      continue;
    }

    const pushReason = checkGitPush(seg, activeCwd);
    if (pushReason) return pushReason;

    const nested = parseNestedCommand(seg);
    if (nested) {
      const reason = checkCommand(nested, activeCwd, _depth + 1);
      if (reason) return reason;
    }
  }

  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let parsed;
  try {
    parsed = readHookInput();
  } catch {
    process.exit(0);
  }
  try {
    const reason = checkCommand(parsed.command, parsed.cwd);
    if (reason) {
      emitDecision(parsed.schema, 'ask', `Remote/shared state guard: command ${reason}. Confirm with the user before running.`);
    } else {
      emitDecision(parsed.schema, 'allow');
    }
  } catch {
    emitDecision(parsed.schema, 'allow');
  }
}
