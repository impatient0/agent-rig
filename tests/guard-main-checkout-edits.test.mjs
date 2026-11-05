import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkEditTarget, existingAncestor, isRiggedRepo } from '../hooks/guard-main-checkout-edits.mjs';

const HOOK = path.resolve(import.meta.dirname, '../hooks/guard-main-checkout-edits.mjs');

function makeRepoWithWorktree(options = {}) {
  const { rigged = 'all' } = options;
  const root = mkdtempSync(path.join(tmpdir(), 'rig-edit-guard-'));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'index.js'), 'export const x = 1;\n');

  if (rigged === 'all' || rigged === 'hookFile') {
    mkdirSync(path.join(root, '.rig/hooks'), { recursive: true });
    writeFileSync(path.join(root, '.rig/hooks/pre-commit'), '#!/bin/sh\nexit 0\n');
  }
  if (rigged === 'legacyHookFile') {
    mkdirSync(path.join(root, 'scripts/git-hooks'), { recursive: true });
    writeFileSync(path.join(root, 'scripts/git-hooks/pre-commit'), '#!/bin/sh\nexit 0\n');
  }
  if (rigged === 'all' || rigged === 'config') {
    git('config', 'core.hooksPath', '.rig/hooks');
  }
  if (rigged === 'legacyConfig') {
    git('config', 'core.hooksPath', 'scripts/git-hooks');
  }

  git('add', '-A');
  git('commit', '-qm', 'init');
  const wt = path.join(root, '.worktrees', 'feat-a');
  git('worktree', 'add', '-q', '-b', 'feature/feat-a', wt, 'main');
  return { root, wt, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('refuses an edit in the main checkout with harness-appropriate remediation and allows edits in a worktree', () => {
  const { root, wt, cleanup } = makeRepoWithWorktree();
  try {
    const defaultReason = checkEditTarget(path.join(root, 'index.js'), { harness: 'antigravity' });
    assert.ok(defaultReason);
    assert.match(defaultReason, /git worktree add/);
    assert.doesNotMatch(defaultReason, /EnterWorktree/);

    const claudeReason = checkEditTarget(path.join(root, 'index.js'), { harness: 'claude' });
    assert.ok(claudeReason);
    assert.match(claudeReason, /EnterWorktree/);

    // Documentation files in the main checkout are permitted
    assert.equal(checkEditTarget(path.join(root, 'docs/backlog.md'), { harness: 'antigravity' }), null);
    assert.equal(checkEditTarget(path.join(root, 'README.md'), { harness: 'claude' }), null);

    assert.equal(checkEditTarget(path.join(wt, 'index.js'), { harness: 'antigravity' }), null);
    assert.equal(checkEditTarget(path.join(wt, 'src/new-file.js'), { harness: 'claude' }), null);
  } finally {
    cleanup();
  }
});

test('allows edits in the main checkout of an unrigged repo', () => {
  const { root, cleanup } = makeRepoWithWorktree({ rigged: false });
  try {
    assert.equal(isRiggedRepo(root), false);
    assert.equal(checkEditTarget(path.join(root, 'index.js'), { harness: 'antigravity' }), null);
    assert.equal(checkEditTarget(path.join(root, 'index.js'), { harness: 'claude' }), null);
    assert.equal(checkEditTarget(path.join(root, 'src/new-file.js')), null);
  } finally {
    cleanup();
  }
});

test('refuses edits in main checkout when repo is rigged via hook file or core.hooksPath', () => {
  const repoViaHookFile = makeRepoWithWorktree({ rigged: 'hookFile' });
  try {
    assert.equal(isRiggedRepo(repoViaHookFile.root), true);
    assert.ok(checkEditTarget(path.join(repoViaHookFile.root, 'index.js'), { harness: 'antigravity' }));
  } finally {
    repoViaHookFile.cleanup();
  }

  const repoViaConfig = makeRepoWithWorktree({ rigged: 'config' });
  try {
    assert.equal(isRiggedRepo(repoViaConfig.root), true);
    assert.ok(checkEditTarget(path.join(repoViaConfig.root, 'index.js'), { harness: 'claude' }));
  } finally {
    repoViaConfig.cleanup();
  }

  const repoViaLegacyHookFile = makeRepoWithWorktree({ rigged: 'legacyHookFile' });
  try {
    assert.equal(isRiggedRepo(repoViaLegacyHookFile.root), true);
    assert.ok(checkEditTarget(path.join(repoViaLegacyHookFile.root, 'index.js'), { harness: 'antigravity' }));
  } finally {
    repoViaLegacyHookFile.cleanup();
  }

  const repoViaLegacyConfig = makeRepoWithWorktree({ rigged: 'legacyConfig' });
  try {
    assert.equal(isRiggedRepo(repoViaLegacyConfig.root), true);
    assert.ok(checkEditTarget(path.join(repoViaLegacyConfig.root, 'index.js'), { harness: 'claude' }));
  } finally {
    repoViaLegacyConfig.cleanup();
  }
});

test('allows relative path edits issued from inside a worktree directory', () => {
  const { root, wt, cleanup } = makeRepoWithWorktree();
  try {
    // Relative edits from worktree are allowed
    assert.equal(checkEditTarget('index.js', { cwd: wt, harness: 'antigravity' }), null);
    assert.equal(checkEditTarget('src/new-file.js', { cwd: wt, harness: 'claude' }), null);
    assert.equal(checkEditTarget('./index.js', { cwd: wt }), null);
    assert.equal(checkEditTarget('nested/dir/new.js', { cwd: wt }), null);

    // Relative edits from rigged main checkout are refused
    assert.ok(checkEditTarget('index.js', { cwd: root, harness: 'antigravity' }));
    assert.ok(checkEditTarget('src/new-file.js', { cwd: root, harness: 'claude' }));

    // Documentation relative edits from main checkout are allowed
    assert.equal(checkEditTarget('README.md', { cwd: root }), null);
    assert.equal(checkEditTarget('docs/backlog.md', { cwd: root }), null);
  } finally {
    cleanup();
  }
});

test('existingAncestor operates on absolute path and resolves relative path against cwd', () => {
  const { root, wt, cleanup } = makeRepoWithWorktree();
  try {
    assert.equal(existingAncestor('index.js', wt), wt);
    assert.equal(existingAncestor('nested/dir/file.js', wt), wt);
    assert.equal(existingAncestor(path.join(wt, 'index.js')), wt);
    assert.equal(existingAncestor('index.js', root), root);
  } finally {
    cleanup();
  }
});

test('end-to-end hook binary handles Antigravity edit_file and Claude Edit payloads', () => {
  const { root, wt, cleanup } = makeRepoWithWorktree();
  try {
    const agyDeny = spawnSync(
      process.execPath,
      [HOOK, '--harness=antigravity'],
      {
        input: JSON.stringify({
          workspacePaths: [root],
          toolCall: { name: 'edit_file', args: { Path: path.join(root, 'index.js') } },
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(JSON.parse(agyDeny.stdout).decision, 'deny');

    const agyAllowDoc = spawnSync(
      process.execPath,
      [HOOK, '--harness=antigravity'],
      {
        input: JSON.stringify({
          workspacePaths: [root],
          toolCall: { name: 'edit_file', args: { Path: path.join(root, 'docs/backlog.md') } },
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(JSON.parse(agyAllowDoc.stdout).decision, 'allow');

    const agyAllow = spawnSync(
      process.execPath,
      [HOOK, '--harness=antigravity'],
      {
        input: JSON.stringify({
          workspacePaths: [root],
          toolCall: { name: 'edit_file', args: { Path: path.join(wt, 'index.js') } },
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(JSON.parse(agyAllow.stdout).decision, 'allow');

    const agyAllowRel = spawnSync(
      process.execPath,
      [HOOK, '--harness=antigravity'],
      {
        input: JSON.stringify({
          workspacePaths: [wt],
          toolCall: { name: 'edit_file', args: { Path: 'index.js' } },
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(JSON.parse(agyAllowRel.stdout).decision, 'allow');

    const claudeDeny = spawnSync(
      process.execPath,
      [HOOK, '--harness=claude'],
      {
        input: JSON.stringify({
          cwd: root,
          tool_name: 'Edit',
          tool_input: { file_path: path.join(root, 'index.js') },
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(JSON.parse(claudeDeny.stdout).hookSpecificOutput.permissionDecision, 'deny');

    const claudeAllowRel = spawnSync(
      process.execPath,
      [HOOK, '--harness=claude'],
      {
        input: JSON.stringify({
          cwd: wt,
          tool_name: 'Edit',
          tool_input: { file_path: 'index.js' },
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(claudeAllowRel.status, 0);
    assert.equal(claudeAllowRel.stdout.trim(), '');
  } finally {
    cleanup();
  }

  const unrigged = makeRepoWithWorktree({ rigged: false });
  try {
    const agyAllowUnrigged = spawnSync(
      process.execPath,
      [HOOK, '--harness=antigravity'],
      {
        input: JSON.stringify({
          workspacePaths: [unrigged.root],
          toolCall: { name: 'edit_file', args: { Path: path.join(unrigged.root, 'index.js') } },
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(JSON.parse(agyAllowUnrigged.stdout).decision, 'allow');

    const claudeAllowUnrigged = spawnSync(
      process.execPath,
      [HOOK, '--harness=claude'],
      {
        input: JSON.stringify({
          cwd: unrigged.root,
          tool_name: 'Edit',
          tool_input: { file_path: path.join(unrigged.root, 'index.js') },
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(claudeAllowUnrigged.status, 0);
    assert.equal(claudeAllowUnrigged.stdout.trim(), '');
  } finally {
    unrigged.cleanup();
  }
});
