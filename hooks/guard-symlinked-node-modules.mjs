#!/usr/bin/env node
// PreToolUse shell guard (`run_command` in Antigravity, `Bash` in Claude Code):
// refuses package-manager install commands (`npm`, `pnpm`, `yarn`, `bun`) when
// the target directory's `node_modules` is a symlink. Also tracks `cd <dir>`
// segments in the same command chain so stateless `run_command` calls that
// `cd .worktrees/<slug> && npm i` from the repo root are still caught.

import { lstatSync } from 'node:fs';
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

const NPM_VERBS = new Set([
  'ci',
  'clean-install',
  'ic',
  'install-ci-test',
  'cit',
  'i',
  'install',
  'add',
  'in',
  'ins',
  'inst',
  'insta',
  'instal',
  'isnt',
  'isnta',
  'isntal',
  'isntall',
]);

const PNPM_VERBS = new Set(['i', 'install', 'add', 'ci', 'clean-install', 'ic']);
const YARN_VERBS = new Set(['install', 'add']);
const BUN_VERBS = new Set(['i', 'install', 'add', 'ci']);

const FLAGS_WITH_VALUE = new Set([
  '-C',
  '--prefix',
  '--dir',
  '--cwd',
  '--userconfig',
  '--globalconfig',
  '--cache',
  '--loglevel',
  '--Otp',
  '--otp',
  '--registry',
  '--script-shell',
  '--tag',
  '--workspace',
  '-w',
]);

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

function parsePmSegment(seg) {
  const { bin, rest } = stripWrappers(tokenize(seg));
  if (!bin) return null;

  if (bin === 'bash' || bin === 'sh' || bin === 'zsh' || bin === 'dash') {
    for (let j = 0; j < rest.length - 1; j++) {
      if (rest[j] === '-c') return { nested: rest[j + 1] };
    }
    return null;
  }
  if (bin === 'eval' && rest.length > 0) {
    return { nested: rest.join(' ') };
  }

  let verbSet = null;
  if (bin === 'npm') verbSet = NPM_VERBS;
  else if (bin === 'pnpm') verbSet = PNPM_VERBS;
  else if (bin === 'yarn') verbSet = YARN_VERBS;
  else if (bin === 'bun') verbSet = BUN_VERBS;
  if (!verbSet) return null;

  let verb = null;
  let global = false;
  let prefix = null;
  let yarnGlobal = false;

  for (let j = 0; j < rest.length; j++) {
    const tok = rest[j];
    if (tok === '--') break;
    if (tok === '-g' || tok === '--global' || tok === '--location=global') {
      global = true;
      continue;
    }
    if (
      tok.startsWith('--prefix=') ||
      tok.startsWith('--dir=') ||
      tok.startsWith('--cwd=')
    ) {
      prefix = tok.slice(tok.indexOf('=') + 1);
      continue;
    }
    if ((tok === '--prefix' || tok === '-C' || tok === '--dir' || tok === '--cwd') && j + 1 < rest.length) {
      prefix = rest[++j];
      continue;
    }
    if (FLAGS_WITH_VALUE.has(tok)) {
      j++;
      continue;
    }
    if (tok.startsWith('-')) continue;
    if (bin === 'yarn' && tok === 'global' && verb === null) {
      yarnGlobal = true;
      global = true;
      continue;
    }
    if (verb === null) verb = tok;
  }

  if (bin === 'yarn' && verb === null && !yarnGlobal) {
    verb = 'install';
  }

  if (!verb || !verbSet.has(verb) || global) return null;
  return { pm: bin, verb, prefix };
}

function splitSegments(cmd) {
  const masked = cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (m) => ' '.repeat(m.length));
  const cuts = [0];
  const sepRe = /[;&|\n]+|\$\(|`/g;
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

function findPmCalls(cmd, baseCwd) {
  const hits = [];
  let activeCwd = baseCwd;
  for (const seg of splitSegments(cmd)) {
    const cdTarget = parseCdSegment(seg);
    if (cdTarget) {
      activeCwd = path.resolve(activeCwd, cdTarget);
      continue;
    }
    const parsed = parsePmSegment(seg);
    if (!parsed) continue;
    if (parsed.nested) {
      hits.push(...findPmCalls(parsed.nested, activeCwd));
    } else {
      hits.push({ ...parsed, effectiveCwd: activeCwd });
    }
  }
  return hits;
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function checkCommand(command, cwd = process.cwd()) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const calls = findPmCalls(stripHeredocs(command), cwd);
  for (const { pm, verb, prefix, effectiveCwd } of calls) {
    const dir = prefix ? path.resolve(effectiveCwd, prefix) : effectiveCwd;
    const nm = path.join(dir, 'node_modules');
    if (isSymlink(nm)) {
      return (
        `Refusing \`${pm} ${verb}\`: \`${nm}\` is a symlink (shared across worktrees). ` +
        `Installing through a symlink mutates or deletes the shared \`node_modules\` tree. ` +
        `If this worktree stays on the same lockfile, keep the symlink and skip \`${pm} ${verb}\`; ` +
        `if this branch changes dependencies, run \`rm "${nm}"\` first so \`${pm} ${verb}\` creates a worktree-local directory.`
      );
    }
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
    const reason = checkCommand(parsed.command, parsed.cwd);
    if (reason) {
      emitDecision(parsed.schema, 'deny', reason);
    } else {
      emitDecision(parsed.schema, 'allow');
    }
  } catch {
    emitDecision(parsed.schema, 'allow');
  }
}
