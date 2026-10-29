import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PRE_COMMIT = path.resolve(import.meta.dirname, '../scripts/git-hooks/pre-commit');
const PRE_MERGE = path.resolve(import.meta.dirname, '../scripts/git-hooks/pre-merge-commit');

function makeRiggedRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-githooks-'));
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  mkdirSync(path.join(root, 'scripts/git-hooks'), { recursive: true });
  copyFileSync(PRE_COMMIT, path.join(root, 'scripts/git-hooks/pre-commit'));
  copyFileSync(PRE_MERGE, path.join(root, 'scripts/git-hooks/pre-merge-commit'));
  chmodSync(path.join(root, 'scripts/git-hooks/pre-commit'), 0o755);
  chmodSync(path.join(root, 'scripts/git-hooks/pre-merge-commit'), 0o755);
  writeFileSync(path.join(root, 'app.js'), 'console.log(1);\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'initial');
  git(root, 'config', 'core.hooksPath', 'scripts/git-hooks');
  git(root, 'switch', '--detach', 'main');
  const wt = path.join(root, '.worktrees/feat-1');
  git(root, 'worktree', 'add', '-q', '-b', 'feature/feat-1', wt, 'main');
  return { root, wt, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('refuses commits in the main checkout and allows commits on a worktree branch', () => {
  const { root, wt, git, cleanup } = makeRiggedRepo();
  try {
    writeFileSync(path.join(root, 'app.js'), 'console.log(2);\n');
    git(root, 'add', 'app.js');
    const rootCommit = git(root, 'commit', '-m', 'illegal root commit');
    assert.notEqual(rootCommit.status, 0);
    assert.match(rootCommit.stderr, /refusing to commit in the main checkout/);
    git(root, 'reset', '--hard', 'HEAD');

    writeFileSync(path.join(wt, 'app.js'), 'console.log(3);\n');
    git(wt, 'add', 'app.js');
    const wtCommit = git(wt, 'commit', '-m', 'feat: valid worktree commit');
    assert.equal(wtCommit.status, 0, wtCommit.stderr);

    // Merging onto main from inside the worktree succeeds, while direct commit on main fails
    assert.equal(git(wt, 'switch', 'main').status, 0);
    writeFileSync(path.join(wt, 'direct.js'), 'x\n');
    git(wt, 'add', 'direct.js');
    const directMain = git(wt, 'commit', '-m', 'illegal direct on main');
    assert.notEqual(directMain.status, 0);
    assert.match(directMain.stderr, /refusing direct commit on 'main'/);
    git(wt, 'reset', '--hard', 'HEAD');
    rmSync(path.join(wt, 'direct.js'), { force: true });

    const mergeRes = git(wt, 'merge', '--no-ff', '-m', 'Merge feature/feat-1', 'feature/feat-1');
    assert.equal(mergeRes.status, 0, mergeRes.stderr);
  } finally {
    cleanup();
  }
});
