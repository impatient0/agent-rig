import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PRE_COMMIT = path.resolve(import.meta.dirname, '../scripts/git-hooks/pre-commit');

function makeRiggedRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-githooks-'));
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  mkdirSync(path.join(root, 'scripts/git-hooks'), { recursive: true });
  copyFileSync(PRE_COMMIT, path.join(root, 'scripts/git-hooks/pre-commit'));
  chmodSync(path.join(root, 'scripts/git-hooks/pre-commit'), 0o755);
  writeFileSync(path.join(root, 'app.js'), 'console.log(1);\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'initial');
  git(root, 'config', 'core.hooksPath', 'scripts/git-hooks');
  const wt = path.join(root, '.worktrees/feat-1');
  git(root, 'worktree', 'add', '-q', '-b', 'feature/feat-1', wt, 'main');
  return { root, wt, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('pre-commit refuses direct commits in the main checkout but allows merge commits', () => {
  const { root, wt, git, cleanup } = makeRiggedRepo();
  try {
    // 1. Direct non-merge commit in root checkout is refused
    writeFileSync(path.join(root, 'app.js'), 'console.log(2);\n');
    git(root, 'add', 'app.js');
    const rootCommit = git(root, 'commit', '-m', 'illegal direct root commit');
    assert.notEqual(rootCommit.status, 0);
    assert.match(rootCommit.stderr, /refusing direct commit in the main checkout/);
    git(root, 'reset', '--hard', 'HEAD');

    // 2. Commit on feature branch inside worktree succeeds
    writeFileSync(path.join(wt, 'app.js'), 'console.log(3);\n');
    git(wt, 'add', 'app.js');
    const wtCommit = git(wt, 'commit', '-m', 'feat: valid worktree commit');
    assert.equal(wtCommit.status, 0, wtCommit.stderr);

    // 3. Merging feature branch in root checkout via --no-commit then commit succeeds
    const mergeNoCommit = git(root, 'merge', '--no-commit', '--no-ff', 'feature/feat-1');
    assert.equal(mergeNoCommit.status, 0, mergeNoCommit.stderr);
    const mergeCommit = git(root, 'commit', '-m', "Merge branch 'feature/feat-1' into main");
    assert.equal(mergeCommit.status, 0, mergeCommit.stderr);

    // 4. Safe branch deletion succeeds because root HEAD is at the merge commit
    git(root, 'worktree', 'remove', wt);
    const branchDel = git(root, 'branch', '-d', 'feature/feat-1');
    assert.equal(branchDel.status, 0, branchDel.stderr);
  } finally {
    cleanup();
  }
});

test('pre-commit allows plain git merge with auto-commit in the main checkout', () => {
  const { root, wt, git, cleanup } = makeRiggedRepo();
  try {
    writeFileSync(path.join(wt, 'feature.js'), 'export const f = 1;\n');
    git(wt, 'add', 'feature.js');
    assert.equal(git(wt, 'commit', '-m', 'feat: new feature').status, 0);

    const autoMerge = git(root, 'merge', '--no-ff', '-m', "Merge branch 'feature/feat-1' into main", 'feature/feat-1');
    assert.equal(autoMerge.status, 0, autoMerge.stderr);
  } finally {
    cleanup();
  }
});

test('pre-commit allows initial commit on an unborn repository', () => {
  const unbornDir = mkdtempSync(path.join(tmpdir(), 'rig-unborn-'));
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  try {
    git(unbornDir, 'init', '-q', '-b', 'main');
    git(unbornDir, 'config', 'user.email', 'test@example.com');
    git(unbornDir, 'config', 'user.name', 'Test');
    mkdirSync(path.join(unbornDir, 'scripts/git-hooks'), { recursive: true });
    copyFileSync(PRE_COMMIT, path.join(unbornDir, 'scripts/git-hooks/pre-commit'));
    chmodSync(path.join(unbornDir, 'scripts/git-hooks/pre-commit'), 0o755);
    git(unbornDir, 'config', 'core.hooksPath', 'scripts/git-hooks');

    writeFileSync(path.join(unbornDir, 'README.md'), '# Unborn\n');
    git(unbornDir, 'add', 'README.md');
    const initCommit = git(unbornDir, 'commit', '-m', 'chore: initial commit');
    assert.equal(initCommit.status, 0, initCommit.stderr);
  } finally {
    rmSync(unbornDir, { recursive: true, force: true });
  }
});

test('pre-commit refuses direct commits on main in a linked worktree', () => {
  const { root, wt, git, cleanup } = makeRiggedRepo();
  try {
    // Switch root to a temporary branch so wt can switch to main
    git(root, 'checkout', '-b', 'temp-park');
    assert.equal(git(wt, 'switch', 'main').status, 0);

    writeFileSync(path.join(wt, 'illegal.js'), 'export const bad = true;\n');
    git(wt, 'add', 'illegal.js');
    const commitOnMainInWt = git(wt, 'commit', '-m', 'illegal commit on main in wt');
    assert.notEqual(commitOnMainInWt.status, 0);
    assert.match(commitOnMainInWt.stderr, /refusing to commit on 'main' in a linked worktree/);
  } finally {
    cleanup();
  }
});
