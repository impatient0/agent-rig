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

test('ansible and ansible-playbook gate remote execution while allowing local inspection flags', () => {
  const { root, cleanup } = makeRepoWithBranch({ rigged: true });
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-'));
  try {
    const opts = { homeDir: fakeHome };

    // Offline / local-only flags pass unprompted
    assert.equal(checkCommand('ansible --version', root, opts), null);
    assert.equal(checkCommand('ansible-playbook --help', root, opts), null);
    assert.equal(checkCommand('ansible-playbook -h', root, opts), null);
    assert.equal(checkCommand('ansible-playbook -i inv.ini --syntax-check site.yml', root, opts), null);
    assert.equal(checkCommand('ansible-playbook -i inv.ini --list-tasks site.yml', root, opts), null);
    assert.equal(checkCommand('ansible-playbook -i inv.ini --list-tags site.yml', root, opts), null);
    assert.equal(checkCommand('ansible all -i inv.ini --list-hosts', root, opts), null);

    // Live runs and --check / -C open SSH connections and prompt
    assert.match(checkCommand('ansible-playbook -i inv.ini site.yml', root, opts), /@remote:ansible/);
    assert.match(checkCommand('ansible-playbook -i inv.ini --check site.yml', root, opts), /@remote:ansible/);
    assert.match(checkCommand('ansible-playbook -i inv.ini -C site.yml', root, opts), /@remote:ansible/);
    assert.match(checkCommand('ansible all -i inv.ini -m ping', root, opts), /@remote:ansible/);
    assert.match(checkCommand('ansible-playbook site.yml -e "note=--help"', root, opts), /@remote:ansible/);

    // Disabling !@remote:ansible in .rig/deny allows live Ansible invocations
    writeFileSync(path.join(root, '.rig', 'deny'), '@defaults\n!@remote:ansible\n', 'utf8');
    assert.equal(checkCommand('ansible-playbook -i inv.ini site.yml', root, opts), null);
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('terraform, tofu, and terragrunt gate plan and mutations with -chdir and .rig/deny overrides', () => {
  const rigged = makeRepoWithBranch({ rigged: true });
  const unrigged = makeRepoWithBranch({ rigged: false });
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-'));
  try {
    const opts = { homeDir: fakeHome };

    // Offline commands pass unprompted
    for (const bin of ['terraform', 'tofu', 'terragrunt']) {
      assert.equal(checkCommand(`${bin} validate`, rigged.root, opts), null);
      assert.equal(checkCommand(`${bin} fmt -check`, rigged.root, opts), null);
      assert.equal(checkCommand(`${bin} version`, rigged.root, opts), null);
      assert.equal(checkCommand(`${bin} --version`, rigged.root, opts), null);
      assert.equal(checkCommand(`${bin} -version`, rigged.root, opts), null);
      assert.equal(checkCommand(`${bin} -v`, rigged.root, opts), null);
      assert.equal(checkCommand(`${bin} --help`, rigged.root, opts), null);
      assert.equal(checkCommand(`${bin} -h`, rigged.root, opts), null);
      assert.equal(checkCommand(`${bin} providers`, rigged.root, opts), null);
      assert.equal(checkCommand(`${bin} init -backend=false`, rigged.root, opts), null);
    }
    assert.equal(checkCommand('terragrunt hclfmt --terragrunt-check', rigged.root, opts), null);
    assert.equal(checkCommand('terraform workspace list', rigged.root, opts), null);

    // Plan is gated under @remote:terraform-plan
    assert.match(checkCommand('terraform plan', rigged.root, opts), /@remote:terraform-plan/);
    assert.match(checkCommand('tofu plan -out=tfplan', rigged.root, opts), /@remote:terraform-plan/);
    assert.match(checkCommand('terragrunt plan', rigged.root, opts), /@remote:terraform-plan/);
    assert.match(checkCommand('terragrunt run-all plan', rigged.root, opts), /@remote:terraform-plan/);
    assert.match(checkCommand('terragrunt run --all plan', rigged.root, opts), /@remote:terraform-plan/);

    // State/infra mutations are gated under @remote:terraform
    for (const cmd of [
      'terraform apply',
      'tofu destroy -auto-approve',
      'terraform import aws_s3_bucket.b bucket',
      'terraform refresh',
      'terraform taint aws_instance.web',
      'terraform untaint aws_instance.web',
      'terraform force-unlock LOCK_ID',
      'terraform console',
      'terraform init',
      'terraform workspace new staging',
      'terraform workspace delete old',
      'terraform workspace select prod',
      'terraform state rm aws_instance.web',
      'terraform state mv a b',
      'terraform state push terraform.tfstate',
      'terraform state replace-provider hashicorp/aws registry.terraform.io/hashicorp/aws',
      'terragrunt run-all apply',
    ]) {
      assert.match(checkCommand(cmd, rigged.root, opts), /@remote:terraform/, `expected ask for: ${cmd}`);
    }

    // -chdir and --terragrunt-working-dir resolve relative to activeCwd into/out of rigged repos
    assert.match(
      checkCommand(`terraform -chdir="${rigged.root}" apply`, unrigged.root, opts),
      /@remote:terraform/,
    );
    assert.match(
      checkCommand(`tofu -chdir "${rigged.root}" plan`, unrigged.root, opts),
      /@remote:terraform-plan/,
    );
    assert.match(
      checkCommand(`terragrunt --terragrunt-working-dir "${rigged.root}" apply`, unrigged.root, opts),
      /@remote:terraform/,
    );
    assert.equal(checkCommand(`terraform -chdir="${unrigged.root}" apply`, rigged.root, opts), null);

    // Negating !@remote:terraform-plan allows plan while keeping apply gated
    writeFileSync(path.join(rigged.root, '.rig', 'deny'), '@defaults\n!@remote:terraform-plan\n', 'utf8');
    assert.equal(checkCommand('terraform plan', rigged.root, opts), null);
    assert.equal(checkCommand('terragrunt run-all plan', rigged.root, opts), null);
    assert.match(checkCommand('terraform apply', rigged.root, opts), /@remote:terraform/);

    // Negating !@remote:terraform allows mutations
    writeFileSync(path.join(rigged.root, '.rig', 'deny'), '@defaults\n!@remote:terraform\n', 'utf8');
    assert.equal(checkCommand('terraform apply', rigged.root, opts), null);
    assert.equal(checkCommand(`terraform -chdir="${rigged.root}" destroy`, unrigged.root, opts), null);
  } finally {
    rigged.cleanup();
    unrigged.cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('kubectl and helm parse global flags, allow client-only invocations, and honor @remote:*-read overrides', () => {
  const { root, cleanup } = makeRepoWithBranch({ rigged: true });
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-'));
  try {
    const opts = { homeDir: fakeHome };

    // kubectl offline invocations
    assert.equal(checkCommand('kubectl --help', root, opts), null);
    assert.equal(checkCommand('kubectl help get', root, opts), null);
    assert.equal(checkCommand('kubectl apply -f app.yaml --dry-run=client', root, opts), null);
    assert.equal(checkCommand('kubectl version --client', root, opts), null);
    assert.equal(checkCommand('kubectl version --client=true', root, opts), null);
    assert.equal(checkCommand('kubectl config current-context', root, opts), null);
    assert.equal(checkCommand('kubectl config get-contexts', root, opts), null);
    assert.equal(checkCommand('kubectl config get-clusters', root, opts), null);
    assert.equal(checkCommand('kubectl config view', root, opts), null);

    // kubectl live reads with global flags before subcommand (@remote:kubectl-read)
    assert.match(
      checkCommand('kubectl --kubeconfig /tmp/kc --context prod -n web get pods', root, opts),
      /@remote:kubectl-read/,
    );
    assert.match(checkCommand('kubectl -n web describe pod api-1', root, opts), /@remote:kubectl-read/);
    assert.match(checkCommand('kubectl logs deploy/api', root, opts), /@remote:kubectl-read/);
    assert.match(checkCommand('kubectl top nodes', root, opts), /@remote:kubectl-read/);
    assert.match(checkCommand('kubectl auth can-i create pods', root, opts), /@remote:kubectl-read/);
    assert.match(checkCommand('kubectl auth whoami', root, opts), /@remote:kubectl-read/);
    assert.match(checkCommand('kubectl version', root, opts), /@remote:kubectl-read/);
    assert.match(checkCommand('kubectl rollout status deploy/api', root, opts), /@remote:kubectl-read/);

    // kubectl mutators and server dry-run (@remote:kubectl)
    for (const cmd of [
      'kubectl -n prod apply -f app.yaml',
      'kubectl apply -f app.yaml --dry-run=server',
      'kubectl -n prod delete pod api-1',
      'kubectl drain node-1 --ignore-daemonsets',
      'kubectl rollout restart deploy/api',
      'kubectl exec -it api-1 -- sh',
      'kubectl port-forward svc/api 8080:80',
      'kubectl auth reconcile -f rbac.yaml',
      'kubectl config use-context prod',
    ]) {
      assert.match(checkCommand(cmd, root, opts), /@remote:kubectl(?!-read)/, `expected @remote:kubectl for: ${cmd}`);
    }

    // helm offline invocations
    for (const cmd of [
      'helm --help',
      'helm lint ./chart',
      'helm template rel ./chart',
      'helm show values ./chart',
      'helm inspect values ./chart',
      'helm search hub nginx',
      'helm version',
      'helm env',
      'helm verify ./chart-0.1.0.tgz',
      'helm create mychart',
      'helm package ./chart',
      'helm dependency list ./chart',
      'helm upgrade --install rel ./chart --dry-run',
      'helm install rel ./chart --dry-run=client',
    ]) {
      assert.equal(checkCommand(cmd, root, opts), null, `expected allow for: ${cmd}`);
    }

    // helm live reads (@remote:helm-read)
    for (const cmd of [
      'helm -n prod --kube-context staging list',
      'helm ls -A',
      'helm status rel',
      'helm history rel',
      'helm get values rel',
    ]) {
      assert.match(checkCommand(cmd, root, opts), /@remote:helm-read/, `expected @remote:helm-read for: ${cmd}`);
    }

    // helm mutators & --dry-run=server (@remote:helm)
    for (const cmd of [
      'helm install rel ./chart',
      'helm upgrade --install rel ./chart --dry-run=server',
      'helm uninstall rel',
      'helm rollback rel 1',
      'helm dependency update ./chart',
      'helm repo add bitnami https://charts.bitnami.com/bitnami',
    ]) {
      assert.match(checkCommand(cmd, root, opts), /@remote:helm(?!-read)/, `expected @remote:helm for: ${cmd}`);
    }

    // Negate read-only switches while keeping mutations gated
    writeFileSync(
      path.join(root, '.rig', 'deny'),
      '@defaults\n!@remote:kubectl-read\n!@remote:helm-read\n',
      'utf8',
    );
    assert.equal(checkCommand('kubectl -n web get pods', root, opts), null);
    assert.equal(checkCommand('helm -n web list', root, opts), null);
    assert.match(checkCommand('kubectl -n web apply -f app.yaml', root, opts), /@remote:kubectl/);
    assert.match(checkCommand('helm upgrade rel ./chart', root, opts), /@remote:helm/);

    // Negate mutation switches
    writeFileSync(
      path.join(root, '.rig', 'deny'),
      '@defaults\n!@remote:kubectl\n!@remote:helm\n',
      'utf8',
    );
    assert.equal(checkCommand('kubectl -n web drain node-1', root, opts), null);
    assert.equal(checkCommand('helm upgrade rel ./chart', root, opts), null);
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('rclone allows local operations, detects <remote>: and :backend: targets, and honors @remote:rclone* rules', () => {
  const { root, cleanup } = makeRepoWithBranch({ rigged: true });
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-'));
  try {
    const opts = { homeDir: fakeHome };

    // Purely local commands and local-to-local transfers pass unprompted
    assert.equal(checkCommand('rclone version', root, opts), null);
    assert.equal(checkCommand('rclone --version', root, opts), null);
    assert.equal(checkCommand('rclone -V', root, opts), null);
    assert.equal(checkCommand('rclone --help', root, opts), null);
    assert.equal(checkCommand('rclone listremotes', root, opts), null);
    assert.equal(checkCommand('rclone obscure secret', root, opts), null);
    assert.equal(checkCommand('rclone genautocomplete bash', root, opts), null);
    assert.equal(checkCommand('rclone copy ./src ./dst', root, opts), null);
    assert.equal(checkCommand('rclone sync C:\\src D:\\dst', root, opts), null);
    assert.equal(checkCommand('rclone copy ./dir/file:v1 ./dst', root, opts), null);
    assert.equal(checkCommand('rclone serve http ./local --addr :8080', root, opts), null);

    // Remote read-only commands (@remote:rclone-read)
    assert.match(checkCommand('rclone ls gdrive:backups', root, opts), /@remote:rclone-read/);
    assert.match(checkCommand('rclone lsd :s3,env_auth=true:my-bucket', root, opts), /@remote:rclone-read/);
    assert.match(checkCommand('rclone lsjson b2:bucket/path', root, opts), /@remote:rclone-read/);
    assert.match(checkCommand('rclone check ./dist s3:bucket/dist', root, opts), /@remote:rclone-read/);

    // Remote mutating / data-access commands (@remote:rclone)
    assert.match(checkCommand('rclone sync ./dist s3:bucket/dist', root, opts), /@remote:rclone(?!-read)/);
    assert.match(checkCommand('rclone copy :sftp,host=box:/data ./local', root, opts), /@remote:rclone(?!-read)/);
    assert.match(checkCommand('rclone purge b2:old-bucket', root, opts), /@remote:rclone(?!-read)/);

    // !@remote:rclone-read allows remote reads while keeping sync/purge gated
    writeFileSync(path.join(root, '.rig', 'deny'), '@defaults\n!@remote:rclone-read\n', 'utf8');
    assert.equal(checkCommand('rclone ls gdrive:backups', root, opts), null);
    assert.match(checkCommand('rclone sync ./dist s3:bucket/dist', root, opts), /@remote:rclone(?!-read)/);

    // !@remote:rclone allows remote mutations
    writeFileSync(path.join(root, '.rig', 'deny'), '@defaults\n!@remote:rclone\n', 'utf8');
    assert.equal(checkCommand('rclone sync ./dist s3:bucket/dist', root, opts), null);
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('IaC and remote orchestration guards remain silent in unrigged repositories', () => {
  const unrigged = makeRepoWithBranch({ rigged: false });
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-'));
  try {
    const opts = { homeDir: fakeHome };
    assert.equal(checkCommand('ansible-playbook -i inv.ini site.yml', unrigged.root, opts), null);
    assert.equal(checkCommand('terraform apply -auto-approve', unrigged.root, opts), null);
    assert.equal(checkCommand('kubectl delete pod api-1', unrigged.root, opts), null);
    assert.equal(checkCommand('helm upgrade --install rel ./chart', unrigged.root, opts), null);
    assert.equal(checkCommand('rclone sync ./dist s3:bucket/dist', unrigged.root, opts), null);
  } finally {
    unrigged.cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
