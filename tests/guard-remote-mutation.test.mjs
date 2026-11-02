import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkCommand } from '../hooks/guard-remote-mutation.mjs';

const HOOK = path.resolve(import.meta.dirname, '../hooks/guard-remote-mutation.mjs');

function makeRepoWithBranch() {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-remote-guard-'));
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

test('flags commands that mutate state outside the working tree', () => {
  assert.ok(checkCommand('ssh user@host ls'));
  assert.ok(checkCommand('scp file.txt user@host:/tmp/'));
  assert.ok(checkCommand('rsync -avz ./dist/ user@host:/var/www/'));
  assert.ok(checkCommand('crontab -e'));
  assert.ok(checkCommand('crontab -r'));
  assert.ok(checkCommand('docker -H ssh://me@box ps'));
  assert.ok(checkCommand('DOCKER_HOST=ssh://me@box docker compose up -d'));
  assert.ok(checkCommand('git push origin main'));
  assert.ok(checkCommand('git push --force origin feature/x'));
  assert.ok(checkCommand('gh pr create --fill'));
  assert.ok(checkCommand('gh release create v1.0.0'));
});

test('flags nested commands, double-quoted subshells, and force refspecs', () => {
  assert.ok(checkCommand('bash -c "git push --force origin main"'));
  assert.ok(checkCommand('echo "$(ssh host)"'));
  const refReason = checkCommand('git push origin +feat:main');
  assert.ok(refReason);
  assert.match(refReason, /pushes directly to `main` \/ `master`|force-pushes or deletes a remote ref/);
  assert.ok(checkCommand('git push origin +ref:ref'));
  assert.ok(checkCommand('eval "git push origin main"'));
  assert.ok(checkCommand('echo `ssh host`'));
});

test('flags bare git push on main and allows bare git push on feature branch', () => {
  const { root, wt, cleanup } = makeRepoWithBranch();
  try {
    assert.ok(checkCommand('git push', root));
    assert.ok(checkCommand('git push origin', root));
    assert.equal(checkCommand('git push', wt), null);
    assert.equal(checkCommand('git push origin', wt), null);
    assert.equal(checkCommand('git push -u origin feature/feat-a', root), null);
  } finally {
    cleanup();
  }
});

test('leaves local work unprompted, including text that merely mentions remote tools', () => {
  assert.equal(checkCommand('npm test'), null);
  assert.equal(checkCommand('crontab -l'), null);
  assert.equal(checkCommand('gh pr view 12'), null);
  assert.equal(checkCommand('gh pr list'), null);
  assert.equal(checkCommand('git push -u origin feature/my-slice'), null);
  assert.equal(checkCommand('git commit -m "fix ssh and rsync docs"'), null);
  assert.equal(checkCommand('echo "git push --force origin main"'), null);
  assert.equal(checkCommand('echo \'$(ssh host)\''), null);
});

test('end-to-end CLI works for both Antigravity and Claude Code stdin payloads', () => {
  const agyRes = spawnSync(
    process.execPath,
    [HOOK, '--harness=antigravity'],
    {
      input: JSON.stringify({
        toolCall: { name: 'run_command', args: { CommandLine: 'git push origin main' } },
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(agyRes.status, 0);
  const agyOut = JSON.parse(agyRes.stdout);
  assert.equal(agyOut.decision, 'ask');

  const claudeRes = spawnSync(
    process.execPath,
    [HOOK, '--harness=claude'],
    {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(claudeRes.status, 0);
  const claudeOut = JSON.parse(claudeRes.stdout);
  assert.equal(claudeOut.hookSpecificOutput.permissionDecision, 'ask');
});

test('end-to-end CLI flags bare git push on main and allows on feature branch', () => {
  const { root, wt, cleanup } = makeRepoWithBranch();
  try {
    const agyAsk = spawnSync(
      process.execPath,
      [HOOK, '--harness=antigravity'],
      {
        input: JSON.stringify({
          workspacePaths: [root],
          toolCall: { name: 'run_command', args: { CommandLine: 'git push' } },
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(agyAsk.status, 0);
    assert.equal(JSON.parse(agyAsk.stdout).decision, 'ask');

    const agyAllow = spawnSync(
      process.execPath,
      [HOOK, '--harness=antigravity'],
      {
        input: JSON.stringify({
          workspacePaths: [wt],
          toolCall: { name: 'run_command', args: { CommandLine: 'git push' } },
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(agyAllow.status, 0);
    assert.equal(JSON.parse(agyAllow.stdout).decision, 'allow');
  } finally {
    cleanup();
  }
});
