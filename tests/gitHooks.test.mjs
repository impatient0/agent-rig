import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPreCommitHook, verifyStamp, initRepo, attachRepo, ejectRepo } from '../bin/rig.mjs';

const PRE_COMMIT = path.resolve(import.meta.dirname, '../.rig/hooks/pre-commit');
const PRE_MERGE_COMMIT = path.resolve(import.meta.dirname, '../.rig/hooks/pre-merge-commit');
const RIG_BIN = path.resolve(import.meta.dirname, '../bin/rig.mjs');
const CHECK_DOC_LINKS = path.resolve(import.meta.dirname, '../scripts/check-doc-links.mjs');
const REFLOW_DOCS = path.resolve(import.meta.dirname, '../scripts/reflow-docs.mjs');

function makeRiggedRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-githooks-'));
  const binDir = path.join(root, 'test-bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'rig'), `#!/usr/bin/env sh\nexec node "${RIG_BIN}" "$@"\n`, { mode: 0o755 });

  const git = (cwd, ...args) =>
    spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');

  mkdirSync(path.join(root, '.rig/hooks'), { recursive: true });
  copyFileSync(PRE_COMMIT, path.join(root, '.rig/hooks/pre-commit'));
  chmodSync(path.join(root, '.rig/hooks/pre-commit'), 0o755);
  copyFileSync(PRE_MERGE_COMMIT, path.join(root, '.rig/hooks/pre-merge-commit'));
  chmodSync(path.join(root, '.rig/hooks/pre-merge-commit'), 0o755);

  mkdirSync(path.join(root, '.rig/bin'), { recursive: true });
  copyFileSync(RIG_BIN, path.join(root, '.rig/bin/rig.mjs'));
  chmodSync(path.join(root, '.rig/bin/rig.mjs'), 0o755);

  mkdirSync(path.join(root, '.rig/scripts'), { recursive: true });
  copyFileSync(CHECK_DOC_LINKS, path.join(root, '.rig/scripts/check-doc-links.mjs'));
  copyFileSync(REFLOW_DOCS, path.join(root, '.rig/scripts/reflow-docs.mjs'));

  writeFileSync(path.join(root, 'app.js'), 'console.log(1);\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'initial');
  git(root, 'config', 'core.hooksPath', '.rig/hooks');
  git(root, 'config', 'branch.main.mergeOptions', '--no-ff');

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

    // 3. Merging feature branch in root checkout via --no-commit then commit is blocked without stamp
    const mergeNoCommitUnstamped = git(root, 'merge', '--no-commit', '--no-ff', 'feature/feat-1');
    assert.equal(mergeNoCommitUnstamped.status, 0, mergeNoCommitUnstamped.stderr);
    const blockedMergeCommit = git(root, 'commit', '-m', "Merge branch 'feature/feat-1' into main");
    assert.notEqual(blockedMergeCommit.status, 0);
    assert.match(blockedMergeCommit.stderr, /has not been stamped by the Cold Verifier/);
    git(root, 'merge', '--abort');

    // 4. After verifyStamp in worktree, merge --no-commit + commit succeeds
    verifyStamp(wt, { homeDir: false });
    const mergeNoCommit = git(root, 'merge', '--no-commit', '--no-ff', 'feature/feat-1');
    assert.equal(mergeNoCommit.status, 0, mergeNoCommit.stderr);
    const mergeCommit = git(root, 'commit', '-m', "Merge branch 'feature/feat-1' into main");
    assert.equal(mergeCommit.status, 0, mergeCommit.stderr);

    // 5. Safe branch deletion succeeds because root HEAD is at the merge commit
    git(root, 'worktree', 'remove', wt);
    const branchDel = git(root, 'branch', '-d', 'feature/feat-1');
    assert.equal(branchDel.status, 0, branchDel.stderr);
  } finally {
    cleanup();
  }
});

test('pre-merge-commit blocks unstamped auto-commit merge and allows stamped merge in the main checkout', () => {
  const { root, wt, git, cleanup } = makeRiggedRepo();
  try {
    writeFileSync(path.join(wt, 'feature.js'), 'export const f = 1;\n');
    git(wt, 'add', 'feature.js');
    assert.equal(git(wt, 'commit', '-m', 'feat: new feature').status, 0);

    // Unstamped auto-commit merge is blocked by pre-merge-commit
    const blockedAutoMerge = git(root, 'merge', '--no-ff', '-m', "Merge branch 'feature/feat-1' into main", 'feature/feat-1');
    assert.notEqual(blockedAutoMerge.status, 0);
    assert.match(blockedAutoMerge.stderr, /has not been stamped by the Cold Verifier/);
    git(root, 'merge', '--abort');

    // After verifyStamp, auto-commit merge succeeds
    verifyStamp(wt, { homeDir: false });
    const autoMerge = git(root, 'merge', '--no-ff', '-m', "Merge branch 'feature/feat-1' into main", 'feature/feat-1');
    assert.equal(autoMerge.status, 0, autoMerge.stderr);
  } finally {
    cleanup();
  }
});

test('pre-commit allows doc-only commits on main checkout and rejects mixed commits', () => {
  const { root, git, cleanup } = makeRiggedRepo();
  try {
    // 1. Doc-only commit on main succeeds when reachability and doc format are valid
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs/backlog.md'), '# Backlog\n\n- Task 1.\n');
    writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n\nSee [docs/backlog.md](docs/backlog.md).\n');
    git(root, 'add', 'AGENTS.md', 'docs/backlog.md');
    const docCommit = git(root, 'commit', '-m', 'docs: update backlog');
    assert.equal(docCommit.status, 0, docCommit.stderr);

    // 2. Mixed commit (code + doc) on main is refused
    writeFileSync(path.join(root, 'docs/backlog.md'), '# Backlog\n\n- Task 2.\n');
    writeFileSync(path.join(root, 'app.js'), 'console.log(99);\n');
    git(root, 'add', 'docs/backlog.md', 'app.js');
    const mixedCommit = git(root, 'commit', '-m', 'feat: mixed code and doc commit');
    assert.notEqual(mixedCommit.status, 0);
    assert.match(mixedCommit.stderr, /refusing direct commit in the main checkout/);
  } finally {
    cleanup();
  }
});

test('pre-commit allows initial commit on an unborn repository', () => {
  const unbornDir = mkdtempSync(path.join(tmpdir(), 'rig-unborn-'));
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env } });
  try {
    git(unbornDir, 'init', '-q', '-b', 'main');
    git(unbornDir, 'config', 'user.email', 'test@example.com');
    git(unbornDir, 'config', 'user.name', 'Test');

    mkdirSync(path.join(unbornDir, '.rig/hooks'), { recursive: true });
    copyFileSync(PRE_COMMIT, path.join(unbornDir, '.rig/hooks/pre-commit'));
    chmodSync(path.join(unbornDir, '.rig/hooks/pre-commit'), 0o755);

    mkdirSync(path.join(unbornDir, '.rig/bin'), { recursive: true });
    copyFileSync(RIG_BIN, path.join(unbornDir, '.rig/bin/rig.mjs'));
    chmodSync(path.join(unbornDir, '.rig/bin/rig.mjs'), 0o755);

    mkdirSync(path.join(unbornDir, '.rig/scripts'), { recursive: true });
    copyFileSync(CHECK_DOC_LINKS, path.join(unbornDir, '.rig/scripts/check-doc-links.mjs'));
    copyFileSync(REFLOW_DOCS, path.join(unbornDir, '.rig/scripts/reflow-docs.mjs'));

    git(unbornDir, 'config', 'core.hooksPath', '.rig/hooks');

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

test('rig hook pre-commit executes worktree and main checkout checks', () => {
  const { root, wt, git, cleanup } = makeRiggedRepo();
  try {
    // In root checkout with code changes
    writeFileSync(path.join(root, 'app.js'), 'console.log(10);\n');
    git(root, 'add', 'app.js');
    const directRes = runPreCommitHook(root);
    assert.equal(directRes.status, 1);
    assert.match(directRes.stderr, /refusing direct commit in the main checkout/);

    // Invoking via CLI binary
    const cliRes = spawnSync(process.execPath, [RIG_BIN, 'hook', 'pre-commit', root], { encoding: 'utf8' });
    assert.equal(cliRes.status, 1);
    assert.match(cliRes.stderr, /refusing direct commit in the main checkout/);

    // In worktree with code changes
    writeFileSync(path.join(wt, 'app.js'), 'console.log(20);\n');
    git(wt, 'add', 'app.js');
    const wtRes = runPreCommitHook(wt);
    assert.equal(wtRes.status, 0);

    const wtCliRes = spawnSync(process.execPath, [RIG_BIN, 'hook', 'pre-commit', wt], { encoding: 'utf8' });
    assert.equal(wtCliRes.status, 0);
  } finally {
    cleanup();
  }
});

test('pre-commit shim invokes vendored .rig/bin/rig.mjs when rig is not in PATH', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-shim-vendored-'));
  const git = (cwd, ...args) =>
    spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' }, // ensure rig is not in PATH
    });
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');

    mkdirSync(path.join(root, '.rig/hooks'), { recursive: true });
    copyFileSync(PRE_COMMIT, path.join(root, '.rig/hooks/pre-commit'));
    chmodSync(path.join(root, '.rig/hooks/pre-commit'), 0o755);

    mkdirSync(path.join(root, '.rig/bin'), { recursive: true });
    copyFileSync(RIG_BIN, path.join(root, '.rig/bin/rig.mjs'));
    chmodSync(path.join(root, '.rig/bin/rig.mjs'), 0o755);

    mkdirSync(path.join(root, '.rig/scripts'), { recursive: true });
    copyFileSync(CHECK_DOC_LINKS, path.join(root, '.rig/scripts/check-doc-links.mjs'));
    copyFileSync(REFLOW_DOCS, path.join(root, '.rig/scripts/reflow-docs.mjs'));

    git(root, 'config', 'core.hooksPath', '.rig/hooks');

    writeFileSync(path.join(root, 'test.js'), 'console.log(1);\n');
    git(root, 'add', 'test.js');
    // First commit on unborn repo passes
    const unbornCommit = git(root, 'commit', '-m', 'chore: initial commit');
    assert.equal(unbornCommit.status, 0, unbornCommit.stderr);

    // Direct commit on main checkout is refused by vendored rig
    writeFileSync(path.join(root, 'test.js'), 'console.log(2);\n');
    git(root, 'add', 'test.js');
    const mainCommit = git(root, 'commit', '-m', 'direct commit');
    assert.notEqual(mainCommit.status, 0);
    assert.match(mainCommit.stderr, /refusing direct commit in the main checkout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pre-commit shim non-rig fallback blocks direct commits on main/master while permitting feature branch commits', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-shim-fallback-'));
  const safeEnv = {
    ...process.env,
    PATH: '/usr/bin:/bin',
    HOME: '/tmp/nonexistent-home',
  };
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: safeEnv });
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');

    // ONLY copy the pre-commit and pre-merge-commit shims into .rig/hooks/ (no .rig/bin/rig.mjs)
    mkdirSync(path.join(root, '.rig/hooks'), { recursive: true });
    copyFileSync(PRE_COMMIT, path.join(root, '.rig/hooks/pre-commit'));
    chmodSync(path.join(root, '.rig/hooks/pre-commit'), 0o755);
    copyFileSync(PRE_MERGE_COMMIT, path.join(root, '.rig/hooks/pre-merge-commit'));
    chmodSync(path.join(root, '.rig/hooks/pre-merge-commit'), 0o755);
    git(root, 'config', 'core.hooksPath', '.rig/hooks');

    // 1. Unborn repo allows initial commit even on main
    writeFileSync(path.join(root, 'initial.txt'), 'first');
    git(root, 'add', 'initial.txt');
    const initRes = git(root, 'commit', '-m', 'initial commit');
    assert.equal(initRes.status, 0, initRes.stderr);

    // 2. Direct commit on main is blocked by non-rig fallback
    writeFileSync(path.join(root, 'initial.txt'), 'second');
    git(root, 'add', 'initial.txt');
    const mainRes = git(root, 'commit', '-m', 'illegal direct commit');
    assert.notEqual(mainRes.status, 0);
    assert.match(mainRes.stderr, /pre-commit: refusing direct commit in the main checkout on main\./);
    git(root, 'reset', '--hard', 'HEAD');

    // 3. Commit on feature branch is PERMITTED by non-rig fallback
    git(root, 'checkout', '-b', 'feature/isolated-test');
    writeFileSync(path.join(root, 'feat.txt'), 'hello feature');
    git(root, 'add', 'feat.txt');
    const featRes = git(root, 'commit', '-m', 'feature commit');
    assert.equal(featRes.status, 0, featRes.stderr);

    // 4. Unstamped merge commit onto main is BLOCKED by non-rig fallback (both pre-commit and pre-merge-commit)
    git(root, 'checkout', 'main');
    const featSha = git(root, 'rev-parse', 'feature/isolated-test').stdout.trim();
    const blockedAuto = git(root, 'merge', '--no-ff', '-m', 'auto merge', 'feature/isolated-test');
    assert.notEqual(blockedAuto.status, 0);
    assert.match(blockedAuto.stderr, /pre-merge-commit: refusing merge onto main/);
    git(root, 'merge', '--abort');

    const mergeNoCommitBlocked = git(root, 'merge', '--no-commit', '--no-ff', 'feature/isolated-test');
    assert.equal(mergeNoCommitBlocked.status, 0, mergeNoCommitBlocked.stderr);
    const blockedCommit = git(root, 'commit', '-m', "Merge branch 'feature/isolated-test' into main");
    assert.notEqual(blockedCommit.status, 0);
    assert.match(blockedCommit.stderr, /pre-commit: refusing merge onto main/);
    git(root, 'merge', '--abort');

    // 5. After stamp file is written, merge commit onto main is PERMITTED by non-rig fallback
    mkdirSync(path.join(root, '.git/rig/verified'), { recursive: true });
    writeFileSync(path.join(root, `.git/rig/verified/${featSha}.json`), JSON.stringify({ sha: featSha }));
    const mergeNoCommit = git(root, 'merge', '--no-commit', '--no-ff', 'feature/isolated-test');
    assert.equal(mergeNoCommit.status, 0, mergeNoCommit.stderr);
    const mergeCommit = git(root, 'commit', '-m', "Merge branch 'feature/isolated-test' into main");
    assert.equal(mergeCommit.status, 0, mergeCommit.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pre-commit allows .rig/ and legacy scripts/git-hooks deletion commits on main checkout and rejects unauthorized paths', () => {
  const { root, wt, git, cleanup } = makeRiggedRepo();
  try {
    // 1. Direct commit on main updating .rig/ file succeeds
    writeFileSync(path.join(root, '.rig/test-asset.txt'), 'asset content\n');
    git(root, 'add', '.rig/test-asset.txt');
    const rigCommit = git(root, 'commit', '-m', 'chore(rig): add rig asset');
    assert.equal(rigCommit.status, 0, rigCommit.stderr);

    // 2. Add a legacy hook via feature branch merge so it exists in main history
    mkdirSync(path.join(wt, 'scripts/git-hooks'), { recursive: true });
    writeFileSync(path.join(wt, 'scripts/git-hooks/pre-commit'), '#!/bin/sh\n# legacy\n');
    git(wt, 'add', 'scripts/git-hooks/pre-commit');
    assert.equal(git(wt, 'commit', '-m', 'chore: add legacy hook in branch').status, 0);
    verifyStamp(wt, { homeDir: false });

    const mergeRes = git(root, 'merge', '--no-commit', '--no-ff', 'feature/feat-1');
    assert.equal(mergeRes.status, 0, mergeRes.stderr);
    assert.equal(git(root, 'commit', '-m', 'Merge legacy hook').status, 0);

    // 3. Deleting legacy scripts/git-hooks/pre-commit directly on main succeeds
    git(root, 'rm', 'scripts/git-hooks/pre-commit');
    const delCommit = git(root, 'commit', '-m', 'chore: remove legacy hook');
    assert.equal(delCommit.status, 0, delCommit.stderr);

    // 4. Combined commit: updating .rig/ and documentation file on main succeeds when docs are valid
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs/backlog.md'), '# Backlog\n\n- Task 1.\n');
    writeFileSync(path.join(root, 'AGENTS.md'), '# App\n\nSee [docs/backlog.md](docs/backlog.md).\n');
    writeFileSync(path.join(root, '.rig/test-asset.txt'), 'asset v2\n');
    git(root, 'add', 'AGENTS.md', 'docs/backlog.md', '.rig/test-asset.txt');
    const comboCommit = git(root, 'commit', '-m', 'docs: update docs and rig asset');
    assert.equal(comboCommit.status, 0, comboCommit.stderr);

    // 5. Combined commit with broken doc link fails doc linter
    writeFileSync(path.join(root, 'AGENTS.md'), '# App\n\nSee [docs/missing.md](docs/missing.md).\n'); // check-doc-links:ignore
    writeFileSync(path.join(root, '.rig/test-asset.txt'), 'asset v3\n');
    git(root, 'add', 'AGENTS.md', '.rig/test-asset.txt');
    const brokenDocCommit = git(root, 'commit', '-m', 'docs: broken doc link');
    assert.notEqual(brokenDocCommit.status, 0);
    assert.match(brokenDocCommit.stderr + brokenDocCommit.stdout, /broken/i);
    git(root, 'reset', '--hard', 'HEAD');

    // 6. Adding a file to scripts/git-hooks/ is NOT a deletion and is rejected on main
    mkdirSync(path.join(root, 'scripts/git-hooks'), { recursive: true });
    writeFileSync(path.join(root, 'scripts/git-hooks/new-hook'), '#!/bin/sh\n');
    git(root, 'add', 'scripts/git-hooks/new-hook');
    const addHookCommit = git(root, 'commit', '-m', 'chore: add new hook illegally');
    assert.notEqual(addHookCommit.status, 0);
    assert.match(addHookCommit.stderr, /refusing direct commit in the main checkout/);
    git(root, 'reset', '--hard', 'HEAD');

    // 7. Direct commit on main updating vendored harness asset (.gemini/skills/...) succeeds
    mkdirSync(path.join(root, '.gemini/skills/dispatch'), { recursive: true });
    writeFileSync(path.join(root, '.gemini/skills/dispatch/SKILL.md'), '# Dispatch\n');
    git(root, 'add', '.gemini/skills/dispatch/SKILL.md');
    const vendoredCommit = git(root, 'commit', '-m', 'chore(rig): update vendored harness skill');
    assert.equal(vendoredCommit.status, 0, vendoredCommit.stderr);

    // 8. Modifying unauthorized path (app.js) alongside .rig/ is rejected on main
    writeFileSync(path.join(root, 'app.js'), 'console.log("unauthorized");\n');
    writeFileSync(path.join(root, '.rig/test-asset.txt'), 'asset v4\n');
    git(root, 'add', 'app.js', '.rig/test-asset.txt');
    const mixedCommit = git(root, 'commit', '-m', 'chore: mixed app and rig');
    assert.notEqual(mixedCommit.status, 0);
    assert.match(mixedCommit.stderr, /refusing direct commit in the main checkout/);
  } finally {
    cleanup();
  }
});

test('bare git merge is forced to --no-ff and gated by rig verify-stamp, and additional commits invalidate the stamp', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-noff-gate-'));
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(path.join(root, 'app.js'), 'console.log(1);\n');
    git(root, 'add', 'app.js');
    git(root, 'commit', '-qm', 'initial');

    // initRepo sets branch.main.mergeOptions = --no-ff and installs pre-commit + pre-merge-commit
    const initRes = initRepo(root, { worktrees: true, homeDir: false });
    assert.equal(initRes.hooksConfigured, true);
    assert.equal(git(root, 'config', '--get', 'branch.main.mergeOptions').stdout.trim(), '--no-ff');

    const wt = initRes.initWorktree.path;
    git(wt, 'commit', '-qm', 'chore(rig): init rig');
    verifyStamp(wt, { homeDir: false });
    assert.equal(git(root, 'merge', '-m', "Merge branch 'chore/rig-init' into main", 'chore/rig-init').status, 0);
    git(root, 'worktree', 'remove', wt);

    // Create a new feature worktree ahead of main (fast-forward candidate!)
    const featWt = path.join(root, '.worktrees/feat-ff');
    git(root, 'worktree', 'add', '-q', '-b', 'feature/feat-ff', featWt, 'main');
    writeFileSync(path.join(featWt, 'feat.js'), 'export const ff = true;\n');
    git(featWt, 'add', 'feat.js');
    assert.equal(git(featWt, 'commit', '-m', 'feat: ff candidate').status, 0);

    // 1. Bare `git merge feature/feat-ff` on main is forced to --no-ff and blocked without stamp
    const bareBlocked = git(root, 'merge', '-m', 'bare merge', 'feature/feat-ff');
    assert.notEqual(bareBlocked.status, 0);
    assert.match(bareBlocked.stderr, /has not been stamped by the Cold Verifier/);
    git(root, 'merge', '--abort');

    // 2. Stamp the feature worktree tip
    const firstStamp = verifyStamp(featWt, { homeDir: false });
    assert.ok(existsSync(firstStamp.stampPath));

    // 3. Making another commit in the worktree invalidates the prior stamp
    writeFileSync(path.join(featWt, 'feat.js'), 'export const ff = false;\n');
    git(featWt, 'add', 'feat.js');
    assert.equal(git(featWt, 'commit', '-m', 'feat: second commit').status, 0);

    const invalidatedBlocked = git(root, 'merge', '-m', 'bare merge after 2nd commit', 'feature/feat-ff');
    assert.notEqual(invalidatedBlocked.status, 0);
    assert.match(invalidatedBlocked.stderr, /has not been stamped by the Cold Verifier/);
    git(root, 'merge', '--abort');

    // 4. Re-stamping the new HEAD allows bare `git merge` (creating a merge commit, not fast-forward)
    const mainBefore = git(root, 'rev-parse', 'main').stdout.trim();
    const featTip = git(featWt, 'rev-parse', 'HEAD').stdout.trim();
    const secondStamp = verifyStamp(featWt, { homeDir: false });
    assert.notEqual(secondStamp.sha, firstStamp.sha);
    assert.equal(secondStamp.sha, featTip);

    const bareOk = git(root, 'merge', '-m', "Merge branch 'feature/feat-ff' into main", 'feature/feat-ff');
    assert.equal(bareOk.status, 0, bareOk.stderr);
    const parents = git(root, 'rev-list', '--parents', '-n', '1', 'HEAD').stdout.trim().split(' ');
    assert.equal(parents.length, 3, 'bare git merge must create a 2-parent merge commit via --no-ff');
    assert.equal(parents[1], mainBefore);
    assert.equal(parents[2], featTip);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyStamp validates branch/cleanliness invariants, writes deterministic metadata, and gracefully falls back without profile catalog', () => {
  const { root, wt, git, cleanup } = makeRiggedRepo();
  try {
    // 1. Refuses main in root checkout
    assert.throws(() => verifyStamp(root, { homeDir: false }), /Refusing to stamp branch 'main' directly/);

    // 2. Refuses master as well
    git(root, 'branch', '-m', 'main', 'master');
    assert.throws(() => verifyStamp(root, { homeDir: false }), /Refusing to stamp branch 'master' directly/);
    git(root, 'branch', '-m', 'master', 'main');

    // 3. Refuses dirty working tree (unstaged tracked modification & staged change)
    writeFileSync(path.join(wt, 'app.js'), 'console.log(999);\n');
    assert.throws(() => verifyStamp(wt, { homeDir: false }), /Refusing to stamp dirty working tree/);
    git(wt, 'add', 'app.js');
    assert.throws(() => verifyStamp(wt, { homeDir: false }), /Refusing to stamp dirty working tree/);
    git(wt, 'commit', '-qm', 'feat: clean commit');

    // 4. Untracked file does not block stamping
    writeFileSync(path.join(wt, 'scratch.tmp'), 'untracked\n');

    // 5. Graceful fallback when rigRoot lacks templates/profiles.json
    const minimalRigRoot = mkdtempSync(path.join(tmpdir(), 'rig-minimal-root-'));
    try {
      const fallbackRes = verifyStamp(wt, { homeDir: false, rigRoot: minimalRigRoot });
      const parsed = JSON.parse(readFileSync(fallbackRes.stampPath, 'utf8'));
      assert.equal(parsed.sha, git(wt, 'rev-parse', 'HEAD').stdout.trim());
      assert.equal(parsed.branch, 'feature/feat-1');
      assert.equal(parsed.baseSha, git(root, 'rev-parse', 'main').stdout.trim());
      assert.ok(Date.parse(parsed.timestamp) > 0);
      assert.equal(parsed.profile, null);
      assert.equal(parsed.workerModel, null);
      assert.equal(parsed.verifierModel, null);
    } finally {
      rmSync(minimalRigRoot, { recursive: true, force: true });
    }

    // 6. Full profile metadata populated when catalog is present
    const fullRes = verifyStamp(wt, { homeDir: false });
    const fullParsed = JSON.parse(readFileSync(fullRes.stampPath, 'utf8'));
    assert.equal(fullParsed.harness, 'antigravity');
    assert.equal(fullParsed.profile, 'antigravity-pro');
    assert.ok(fullParsed.workerModel);
    assert.ok(fullParsed.verifierModel);
  } finally {
    cleanup();
  }
});

test('ejectRepo unsets branch.main.mergeOptions when --no-ff while preserving custom mergeOptions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-eject-mergeopt-'));
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(path.join(root, 'AGENTS.md'), '# App\n');
    git(root, 'add', 'AGENTS.md');
    git(root, 'commit', '-qm', 'init');

    attachRepo(root, { homeDir: false });
    assert.equal(git(root, 'config', '--get', 'branch.main.mergeOptions').stdout.trim(), '--no-ff');

    // Set a custom non-rig mergeOptions on master to ensure ejectRepo leaves it untouched
    git(root, 'config', 'branch.master.mergeOptions', '--ff-only');

    ejectRepo(root, { homeDir: false });
    assert.equal(git(root, 'config', '--get', 'branch.main.mergeOptions').stdout.trim(), '');
    assert.equal(git(root, 'config', '--get', 'branch.master.mergeOptions').stdout.trim(), '--ff-only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
