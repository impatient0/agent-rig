import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkEditTarget } from '../hooks/guard-main-checkout-edits.mjs';

const HOOK = path.resolve(import.meta.dirname, '../hooks/guard-main-checkout-edits.mjs');

function makeRepoWithWorktree() {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-edit-guard-'));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'index.js'), 'export const x = 1;\n');
  git('add', 'index.js');
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

    assert.equal(checkEditTarget(path.join(wt, 'index.js'), { harness: 'antigravity' }), null);
    assert.equal(checkEditTarget(path.join(wt, 'src/new-file.js'), { harness: 'claude' }), null);
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
  } finally {
    cleanup();
  }
});
