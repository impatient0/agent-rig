#!/usr/bin/env node
// PreToolUse shell guard (`run_command` in Antigravity, `Bash` in Claude Code):
// refuses package-manager install commands (`npm`, `pnpm`, `yarn`, `bun`) when
// the target directory's `node_modules` is a symlink. Also tracks `cd <dir>`
// segments in the same command chain so stateless `run_command` calls that
// `cd .worktrees/<slug> && npm i` from the repo root are still caught.

import { lstatSync } from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readHookInput, emitDecision, isDirectoryInRiggedRepo } from './lib/hook-io.mjs';
import {
  stripHeredocs,
  stripWrappers,
  parseCdSegment,
  parseNestedCommand,
  extractSubshells,
  parseCommandLists,
} from './lib/shell-parser.mjs';

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
  'uninstall',
  'unlink',
  'remove',
  'rm',
  'r',
  'un',
  'update',
  'up',
  'upgrade',
  'prune',
  'dedupe',
  'rebuild',
  'rb',
  'link',
  'ln',
]);

const PNPM_VERBS = new Set([
  'i',
  'install',
  'add',
  'ci',
  'clean-install',
  'ic',
  'remove',
  'rm',
  'uninstall',
  'un',
  'update',
  'up',
  'upgrade',
  'prune',
  'dedupe',
  'rebuild',
  'link',
  'unlink',
]);

const YARN_VERBS = new Set([
  'install',
  'add',
  'remove',
  'upgrade',
  'upgrade-interactive',
  'autoclean',
  'dedupe',
  'unlink',
  'link',
]);

const BUN_VERBS = new Set([
  'i',
  'install',
  'add',
  'ci',
  'remove',
  'rm',
  'update',
  'upgrade',
  'link',
  'unlink',
]);

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

function parsePmTokens(tokens) {
  const { bin, rest } = stripWrappers(tokens);
  if (!bin) return null;

  const nested = parseNestedCommand(tokens);
  if (nested) return { nested };

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

function findPmCalls(cmd, baseCwd, _depth = 0) {
  if (_depth > 10) return [];
  const hits = [];
  let activeCwd = baseCwd;
  for (const list of parseCommandLists(cmd)) {
    if (list.stages.length === 1) {
      const cdTarget = parseCdSegment(list.stages[0].tokens);
      if (cdTarget) {
        activeCwd = path.resolve(activeCwd, cdTarget);
        continue;
      }
    }
    for (const stage of list.stages) {
      for (const sub of extractSubshells(stage.raw)) {
        hits.push(...findPmCalls(sub, activeCwd, _depth + 1));
      }
      const parsed = parsePmTokens(stage.tokens);
      if (!parsed) continue;
      if (parsed.nested) {
        hits.push(...findPmCalls(parsed.nested, activeCwd, _depth + 1));
      } else {
        hits.push({ ...parsed, effectiveCwd: activeCwd });
      }
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
    // Enforce symlinked node_modules guard only inside rigged repositories
    // (governed by docs/adr/0004-strict-unrigged-repository-isolation.md).
    if (!isDirectoryInRiggedRepo(dir)) continue;
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
      emitDecision(parsed.schema, 'deny', reason);
    } else {
      emitDecision(parsed.schema, 'allow');
    }
  } catch {
    emitDecision(parsed.schema, 'allow');
  }
}
