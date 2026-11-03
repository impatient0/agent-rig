#!/usr/bin/env node
// PreToolUse file-edit guard (`edit_file`/`write_file` in Antigravity,
// `Edit`/`Write` in Claude Code): refuses file edits in the main checkout so
// parallel sessions never share a working copy.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHookInput, emitDecision } from './lib/hook-io.mjs';

export function existingAncestor(targetPath, cwd = process.cwd()) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return null;
  const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
  let dir = abs;
  try {
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      dir = path.dirname(abs);
    }
  } catch {
    dir = path.dirname(abs);
  }
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return dir;
}

function buildRemediation(harness) {
  if (harness === 'claude') {
    return (
      'Main checkout is read-only for code by convention (see AGENTS.md). ' +
      'Call EnterWorktree first (or spawn a subagent with isolation: "worktree"), ' +
      'rename the branch to <type>/<slug>, and symlink node_modules if present.'
    );
  }
  return (
    'Main checkout is read-only for code by convention (see AGENTS.md). ' +
    'Create a linked git worktree first (e.g. `git worktree add .worktrees/<slug> -b <type>/<slug>` ' +
    'or spawn a subagent with Workspace: "share"), symlink node_modules if present, ' +
    'and target all file edits and commands inside that worktree path.'
  );
}

export function isDocFile(filePath, repoRoot) {
  const rel = path.relative(repoRoot, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const normalized = rel.split(path.sep).join('/');
  return normalized === 'README.md' || normalized.startsWith('docs/');
}

export function isRiggedRepo(repoRoot) {
  if (!repoRoot || typeof repoRoot !== 'string') return false;

  // Verify that scripts/git-hooks/pre-commit exists in the repo
  if (existsSync(path.join(repoRoot, 'scripts/git-hooks/pre-commit'))) {
    return true;
  }

  // Verify whether git config --get core.hooksPath resolves to scripts/git-hooks (or ends with scripts/git-hooks)
  try {
    const res = spawnSync('git', ['-C', repoRoot, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
    if (res.status === 0) {
      const hooksPath = res.stdout.trim();
      if (hooksPath) {
        const normalized = hooksPath.replace(/\\/g, '/').replace(/\/+$/, '');
        if (normalized === 'scripts/git-hooks' || normalized.endsWith('/scripts/git-hooks')) {
          return true;
        }
        if (path.resolve(repoRoot, hooksPath) === path.resolve(repoRoot, 'scripts/git-hooks')) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }

  return false;
}

export function checkEditTarget(filePath, options = {}) {
  const harness = options?.harness ?? 'generic';
  const cwd = (typeof options?.cwd === 'string' && options.cwd.trim()) ? options.cwd : process.cwd();
  if (typeof filePath !== 'string' || !filePath.trim()) return null;

  const absPath = path.resolve(cwd, filePath);
  const dir = existingAncestor(absPath, cwd);
  if (!dir) return null;

  const res = spawnSync(
    'git',
    ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) return null;

  const [gitDir, commonDir, topLevel] = res.stdout.trim().split('\n');
  if (!gitDir || !commonDir || !topLevel) return null;

  // In a linked worktree, --git-dir is <common>/worktrees/<name>; in the main
  // checkout the two paths are identical.
  if (gitDir !== commonDir) return null;

  // If the repository is not rigged under agent-rig conventions, permit edits
  // in the main checkout so globally-installed hooks do not block unrigged repos.
  if (!isRiggedRepo(topLevel)) return null;

  // Documentation and backlog files can be edited directly in the main checkout.
  if (isDocFile(absPath, topLevel)) return null;

  return buildRemediation(harness);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let parsed;
  try {
    parsed = readHookInput();
  } catch {
    process.exit(0);
  }
  try {
    const reason = checkEditTarget(parsed.filePath, { harness: parsed.harness, cwd: parsed.cwd });
    if (reason) {
      emitDecision(parsed.schema, 'deny', reason);
    } else {
      emitDecision(parsed.schema, 'allow');
    }
  } catch {
    emitDecision(parsed.schema, 'allow');
  }
}
