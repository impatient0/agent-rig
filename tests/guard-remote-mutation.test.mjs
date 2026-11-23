import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkCommand, evaluateCommand } from '../hooks/guard-remote-mutation.mjs';
import {
  allowRemoteHost,
  revokeRemoteHost,
  clearRemoteHosts,
  parseDurationMs,
  readSshConfigAllowlist,
  DEFAULT_TTL_MS,
} from '../hooks/lib/remote-allowlist.mjs';

const HOOK = path.resolve(import.meta.dirname, '../hooks/guard-remote-mutation.mjs');
const RIG_BIN = path.resolve(import.meta.dirname, '../bin/rig.mjs');

function makeRepoWithBranch({ rigged = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-remote-guard-'));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'index.js'), 'export const x = 1;\n');
  if (rigged) {
    mkdirSync(path.join(root, '.rig/hooks'), { recursive: true });
    writeFileSync(path.join(root, '.rig/hooks/pre-commit'), '#!/bin/sh\nexit 0\n');
  }
  git('add', '-A');
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

test('does not trigger in unrigged repositories unless command explicitly targets a rigged repository', () => {
  const unrigged = makeRepoWithBranch({ rigged: false });
  const rigged = makeRepoWithBranch({ rigged: true });
  try {
    // Commands inside an unrigged repository are allowed unprompted
    assert.equal(checkCommand('ssh nerd "docker exec -u hermes hermes python3 -c \'print(1)\'"', unrigged.root), null);
    assert.equal(checkCommand('scp file.txt user@host:/tmp/', unrigged.root), null);
    assert.equal(checkCommand('git push origin main', unrigged.root), null);
    assert.equal(checkCommand('git push', unrigged.root), null);
    assert.equal(checkCommand('git push --force origin feature/x', unrigged.root), null);
    assert.equal(checkCommand('gh pr create --fill', unrigged.root), null);

    // End-to-end CLI payloads for an unrigged workspace return allow
    const agyAllow = spawnSync(
      process.execPath,
      [HOOK, '--harness=antigravity'],
      {
        input: JSON.stringify({
          workspacePaths: [unrigged.root],
          toolCall: { name: 'run_command', args: { CommandLine: 'ssh nerd "ls"' } },
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(agyAllow.status, 0);
    assert.equal(JSON.parse(agyAllow.stdout).decision, 'allow');

    const claudeAllow = spawnSync(
      process.execPath,
      [HOOK, '--harness=claude'],
      {
        input: JSON.stringify({
          cwd: unrigged.root,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ssh nerd "ls"' },
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(claudeAllow.status, 0);
    assert.equal(claudeAllow.stdout.trim(), '');

    // Commands that cd or git -C from an unrigged directory into a rigged repository are still guarded
    assert.ok(checkCommand(`cd "${rigged.root}" && ssh user@host ls`, unrigged.root));
    assert.ok(checkCommand(`git -C "${rigged.root}" push origin main`, unrigged.root));
    assert.equal(checkCommand(`git -C "${unrigged.root}" push origin main`, rigged.root), null);
  } finally {
    unrigged.cleanup();
    rigged.cleanup();
  }
});

test('repo-scoped allowlist allows SSH-family and remote Docker commands for allowlisted hosts across worktrees', () => {
  const { root, wt, cleanup } = makeRepoWithBranch({ rigged: true });
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-'));
  try {
    const now = Date.parse('2026-11-24T00:00:00.000Z');
    const opts = { now, homeDir: fakeHome };

    // Before allowlisting, burner-vps prompts
    assert.ok(checkCommand('ssh root@burner-vps ls', root, opts));
    assert.ok(checkCommand('docker -H ssh://root@burner-vps ps', root, opts));

    // Local-only rsync does not prompt even without an allowlist
    assert.equal(checkCommand('rsync -av ./src/ ./dst/', root, opts), null);

    // Allowlist burner-vps (defaults to 24h TTL)
    const entry = allowRemoteHost(root, 'burner-vps', { now });
    assert.equal(entry.host, 'burner-vps');
    assert.equal(Date.parse(entry.expiresAt) - now, DEFAULT_TTL_MS);

    // Allowed from both root checkout and linked worktree
    for (const dir of [root, wt]) {
      assert.equal(checkCommand('ssh burner-vps uptime', dir, opts), null);
      assert.equal(checkCommand('ssh -tt -p 2222 -i ~/.ssh/id_ed25519 root@burner-vps "docker ps"', dir, opts), null);
      assert.equal(checkCommand('scp ./app.tar.gz root@burner-vps:/tmp/', dir, opts), null);
      assert.equal(checkCommand('sftp -P 2222 root@burner-vps:/var/log', dir, opts), null);
      assert.equal(checkCommand('rsync -avz -e "ssh -p 2222" ./dist/ root@burner-vps:/var/www/', dir, opts), null);
      assert.equal(checkCommand('docker -H ssh://root@burner-vps ps', dir, opts), null);
      assert.equal(checkCommand('docker --host=tcp://burner-vps:2375 ps', dir, opts), null);
      assert.equal(checkCommand('docker --context burner-vps ps', dir, opts), null);
      assert.equal(checkCommand('DOCKER_HOST=ssh://root@burner-vps docker compose up -d', dir, opts), null);
    }

    // Non-allowlisted hosts and mixed-host commands still fail closed (ask)
    assert.ok(checkCommand('ssh root@prod-box uptime', root, opts));
    assert.ok(checkCommand('scp burner-vps:/tmp/a prod-box:/tmp/b', root, opts));
    assert.ok(checkCommand('docker -H ssh://root@prod-box ps', root, opts));
    assert.ok(checkCommand('DOCKER_HOST=ssh://root@prod-box docker ps', root, opts));

    // Expiry check: after 24h, burner-vps prompts again
    const afterExpiry = { now: now + DEFAULT_TTL_MS + 1000, homeDir: fakeHome };
    assert.ok(checkCommand('ssh root@burner-vps uptime', root, afterExpiry));

    // Permanent entry never expires
    allowRemoteHost(root, 'burner-vps', { permanent: true, now });
    assert.equal(checkCommand('ssh root@burner-vps uptime', root, { now: now + 365 * DEFAULT_TTL_MS, homeDir: fakeHome }), null);

    // Revoke immediately re-enables prompt
    const rev = revokeRemoteHost(root, 'burner-vps', { now });
    assert.equal(rev.removed, true);
    assert.ok(checkCommand('ssh root@burner-vps uptime', root, opts));

    // Clear removes all entries
    allowRemoteHost(root, 'burner-a', { ttlMs: parseDurationMs('4h'), now });
    allowRemoteHost(root, 'burner-b', { ttlMs: parseDurationMs('4h'), now });
    const cleared = clearRemoteHosts(root);
    assert.equal(cleared.clearedCount, 2);
    assert.ok(checkCommand('ssh burner-a uptime', root, opts));
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('fails closed on ambiguous SSH options, variables, unallowed jump hosts, and rig allow self-escalation', () => {
  const { root, cleanup } = makeRepoWithBranch({ rigged: true });
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-'));
  try {
    const now = Date.parse('2026-11-24T00:00:00.000Z');
    const opts = { now, homeDir: fakeHome };
    allowRemoteHost(root, 'burner-vps', { now });

    // Variable expansion and custom ssh config fail closed
    assert.ok(checkCommand('ssh "$HOST" uptime', root, opts));
    assert.ok(checkCommand('ssh -F /tmp/custom_ssh_config burner-vps uptime', root, opts));
    assert.ok(checkCommand('ssh -o ProxyCommand="nc prod-box 22" burner-vps uptime', root, opts));
    assert.ok(checkCommand('ssh -o LocalCommand="touch /tmp/pwn" burner-vps uptime', root, opts));
    assert.ok(checkCommand('ssh -o HostName=prod-box burner-vps uptime', root, opts));

    // Jump host must also be allowlisted
    assert.ok(checkCommand('ssh -J prod-bastion burner-vps uptime', root, opts));
    assert.ok(checkCommand('ssh -o ProxyJump=prod-bastion burner-vps uptime', root, opts));
    allowRemoteHost(root, 'burner-bastion', { now });
    assert.equal(checkCommand('ssh -J burner-bastion burner-vps uptime', root, opts), null);
    assert.equal(checkCommand('ssh -o ProxyJump=burner-bastion burner-vps uptime', root, opts), null);

    // Self-escalation guard: mutating `rig allow` prompts, read-only `--list` does not
    assert.ok(checkCommand('rig allow remote prod-box', root, opts));
    assert.ok(checkCommand('rig allow remote --clear', root, opts));
    assert.ok(checkCommand('node bin/rig.mjs allow remote prod-box', root, opts));
    assert.equal(checkCommand('rig allow remote --list', root, opts), null);
    assert.equal(checkCommand('rig allow remote list', root, opts), null);
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('~/.ssh/config # agent-rig: allow marker allows exact Host aliases and ignores wildcards and Match blocks', () => {
  const { root, cleanup } = makeRepoWithBranch({ rigged: true });
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-'));
  try {
    mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true });
    writeFileSync(
      path.join(fakeHome, '.ssh', 'config'),
      [
        'Host burner-inline # agent-rig: allow',
        '  HostName 203.0.113.10',
        '',
        'Host burner-block burner-two',
        '  # agent-rig: allow',
        '  User root',
        '',
        'Host *',
        '  # agent-rig: allow',
        '  ServerAliveInterval 60',
        '',
        'Host *.staging',
        '  # agent-rig: allow',
        '',
        'Host unannotated-prod',
        '  HostName 198.51.100.5',
        '',
        'Match host prod-match',
        '  # agent-rig: allow',
      ].join('\n') + '\n',
      'utf8',
    );

    const parsed = readSshConfigAllowlist({ homeDir: fakeHome });
    assert.deepEqual([...parsed].sort(), ['burner-block', 'burner-inline', 'burner-two']);

    const opts = { homeDir: fakeHome };
    assert.equal(checkCommand('ssh burner-inline uptime', root, opts), null);
    assert.equal(checkCommand('ssh burner-block uptime', root, opts), null);
    assert.equal(checkCommand('ssh burner-two uptime', root, opts), null);
    assert.ok(checkCommand('ssh unannotated-prod uptime', root, opts));
    assert.ok(checkCommand('ssh app.staging uptime', root, opts));
    assert.ok(checkCommand('ssh prod-match uptime', root, opts));
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('explicit allow override applies to pure allowlisted commands on Claude Code, and defers on mixed chains', () => {
  const { root, cleanup } = makeRepoWithBranch({ rigged: true });
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-'));
  try {
    allowRemoteHost(root, 'burner-vps', { ttlMs: parseDurationMs('4h') });

    // Pure allowlisted command -> explicitAllow = true
    const pureEval = evaluateCommand('ssh root@burner-vps uptime', root, { homeDir: fakeHome });
    assert.equal(pureEval.decision, 'allow');
    assert.equal(pureEval.explicitAllow, true);

    // Mixed chain with local command -> explicitAllow = false (defers so local half is not auto-approved)
    const mixedEval = evaluateCommand('ssh root@burner-vps uptime && echo done', root, { homeDir: fakeHome });
    assert.equal(mixedEval.decision, 'allow');
    assert.equal(mixedEval.explicitAllow, false);

    // End-to-end Claude Code hook emits explicit permissionDecision: "allow" for pure allowlisted SSH
    const claudeAllow = spawnSync(process.execPath, [HOOK, '--harness=claude'], {
      env: { ...process.env, HOME: fakeHome },
      input: JSON.stringify({
        cwd: root,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ssh root@burner-vps uptime' },
      }),
      encoding: 'utf8',
    });
    assert.equal(claudeAllow.status, 0);
    const claudeOut = JSON.parse(claudeAllow.stdout);
    assert.equal(claudeOut.hookSpecificOutput.permissionDecision, 'allow');

    // End-to-end Claude Code hook defers (empty stdout) on mixed chain
    const claudeDefer = spawnSync(process.execPath, [HOOK, '--harness=claude'], {
      env: { ...process.env, HOME: fakeHome },
      input: JSON.stringify({
        cwd: root,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ssh root@burner-vps uptime && echo done' },
      }),
      encoding: 'utf8',
    });
    assert.equal(claudeDefer.status, 0);
    assert.equal(claudeDefer.stdout.trim(), '');
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('rig allow remote CLI manages repo-scoped entries and lists ~/.ssh/config fallback hosts', () => {
  const { root, cleanup } = makeRepoWithBranch({ rigged: true });
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-'));
  try {
    mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true });
    writeFileSync(
      path.join(fakeHome, '.ssh', 'config'),
      'Host ssh-fallback\n  # agent-rig: allow\n',
      'utf8',
    );

    const addRes = spawnSync(
      process.execPath,
      [RIG_BIN, 'allow', 'remote', 'burner-cli', '--ttl', '4h', root, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(addRes.status, 0, addRes.stderr);
    const added = JSON.parse(addRes.stdout);
    assert.equal(added.host, 'burner-cli');
    assert.ok(added.expiresAt);

    const listRes = spawnSync(
      process.execPath,
      [RIG_BIN, 'allow', 'remote', '--list', root, '--home', fakeHome, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(listRes.status, 0, listRes.stderr);
    const listed = JSON.parse(listRes.stdout);
    assert.deepEqual(listed.repoHosts.map((h) => h.host), ['burner-cli']);
    assert.deepEqual(listed.sshConfigHosts, ['ssh-fallback']);

    const revokeRes = spawnSync(
      process.execPath,
      [RIG_BIN, 'allow', 'remote', '--revoke', 'burner-cli', root, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(revokeRes.status, 0, revokeRes.stderr);
    assert.equal(JSON.parse(revokeRes.stdout).removed, true);
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
