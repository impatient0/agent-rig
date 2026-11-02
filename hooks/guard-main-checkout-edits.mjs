#!/usr/bin/env node
// PreToolUse file-edit guard (`edit_file`/`write_file` in Antigravity,
// `Edit`/`Write` in Claude Code): refuses file edits in the main checkout so
// parallel sessions never share a working copy.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readHookInput, emitDecision } from './lib/hook-io.mjs';

function existingAncestor(absPath) {
  let dir = path.dirname(absPath);
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

export function checkEditTarget(filePath, { harness = 'generic', cwd = process.cwd() } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;

  const absPath = path.resolve(cwd, filePath);
  const dir = existingAncestor(absPath);
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
