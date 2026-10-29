import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { checkCommand } from '../hooks/guard-remote-mutation.mjs';

const HOOK = path.resolve(import.meta.dirname, '../hooks/guard-remote-mutation.mjs');

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

test('leaves local work unprompted, including text that merely mentions remote tools', () => {
  assert.equal(checkCommand('npm test'), null);
  assert.equal(checkCommand('crontab -l'), null);
  assert.equal(checkCommand('gh pr view 12'), null);
  assert.equal(checkCommand('gh pr list'), null);
  assert.equal(checkCommand('git push -u origin feature/my-slice'), null);
  assert.equal(checkCommand('git commit -m "fix ssh and rsync docs"'), null);
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
