import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkCommand } from '../hooks/guard-symlinked-node-modules.mjs';

function makeWorktreeWithSymlink() {
  const base = mkdtempSync(path.join(tmpdir(), 'rig-nm-'));
  const realNm = path.join(base, 'node_modules');
  const wt = path.join(base, '.worktrees', 'slice-1');
  mkdirSync(realNm, { recursive: true });
  mkdirSync(wt, { recursive: true });
  symlinkSync(realNm, path.join(wt, 'node_modules'));
  return { base, wt, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('refuses npm, pnpm, yarn, and bun installs when cwd has a symlinked node_modules', () => {
  const { wt, cleanup } = makeWorktreeWithSymlink();
  try {
    assert.ok(checkCommand('npm ci', wt));
    assert.ok(checkCommand('npm install', wt));
    assert.ok(checkCommand('pnpm i', wt));
    assert.ok(checkCommand('yarn add zod', wt));
    assert.ok(checkCommand('bun install', wt));
    assert.equal(checkCommand('npm test', wt), null);
    assert.equal(checkCommand('npm install -g typescript', wt), null);
  } finally {
    cleanup();
  }
});

test('follows a leading cd <worktree> && segment when run_command starts at the repo root', () => {
  const { base, cleanup } = makeWorktreeWithSymlink();
  try {
    assert.ok(checkCommand('cd .worktrees/slice-1 && npm install', base));
    assert.ok(checkCommand('cd .worktrees/slice-1; pnpm add playwright', base));
    assert.equal(checkCommand('cd .worktrees/slice-1 && npm test', base), null);
    assert.equal(checkCommand('npm install', base), null);
  } finally {
    cleanup();
  }
});
