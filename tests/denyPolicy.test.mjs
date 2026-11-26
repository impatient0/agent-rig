import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadDenyPolicy,
  evaluatePath,
  isPathDenied,
  isSearchGlobDenied,
  isRuleEnabled,
  isDenyPolicyFile,
} from '../hooks/lib/deny-policy.mjs';

const RIG_ROOT = path.resolve(import.meta.dirname, '..');

function makeRepoWithWorktree() {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-deny-policy-'));
  const homeDir = mkdtempSync(path.join(tmpdir(), 'rig-deny-home-'));
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'README.md'), '# test\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  const wt = path.join(root, '.worktrees', 'feat-1');
  git(root, 'worktree', 'add', '-q', '-b', 'feature/feat-1', wt, 'main');
  return {
    root,
    wt,
    homeDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

test('@defaults denies built-in host and repo secret globs while allowing safe exemptions and enabling default rule switches', () => {
  const { root, homeDir, cleanup } = makeRepoWithWorktree();
  try {
    const policy = loadDenyPolicy({ cwd: root, homeDir, rigRoot: RIG_ROOT });

    // Host credential stores
    assert.equal(isPathDenied(policy, path.join(homeDir, '.ssh/id_ed25519')), true);
    assert.equal(isPathDenied(policy, '~/.ssh/id_rsa'), true);
    assert.equal(isPathDenied(policy, '~/.ssh/id_ed25519.pub'), false);
    assert.equal(isPathDenied(policy, '~/.gnupg/secring.gpg'), true);
    assert.equal(isPathDenied(policy, '~/.gnupg', { isDirectory: true }), true);
    assert.equal(isPathDenied(policy, '~/.aws/credentials'), true);
    assert.equal(isPathDenied(policy, '~/.config/sops/age/keys.txt'), true);
    assert.equal(isPathDenied(policy, '~/.kube/config'), true);
    assert.equal(isPathDenied(policy, '~/.config/rclone/rclone.conf'), true);
    assert.equal(isPathDenied(policy, '~/.netrc'), true);
    assert.equal(isPathDenied(policy, '~/.npmrc'), true);
    assert.equal(isPathDenied(policy, '~/.pypirc'), true);
    assert.equal(isPathDenied(policy, '~/.docker/config.json'), true);
    assert.equal(isPathDenied(policy, '~/.config/gh/hosts.yml'), true);

    // Repo & nested secret globs
    assert.equal(isPathDenied(policy, path.join(root, '.env')), true);
    assert.equal(isPathDenied(policy, path.join(root, 'apps/api/.env.production')), true);
    assert.equal(isPathDenied(policy, path.join(root, 'certs/server.key')), true);
    assert.equal(isPathDenied(policy, path.join(root, 'certs/bundle.p12')), true);
    assert.equal(isPathDenied(policy, path.join(root, 'certs/bundle.pfx')), true);
    assert.equal(isPathDenied(policy, path.join(root, 'keys/dev.agekey')), true);
    assert.equal(isPathDenied(policy, path.join(root, 'infra/terraform.tfstate')), true);
    assert.equal(isPathDenied(policy, path.join(root, 'infra/terraform.tfstate.backup')), true);
    assert.equal(isPathDenied(policy, path.join(root, 'ansible/.vault_pass.txt')), true);

    // Safe exemptions after deny globs
    assert.equal(isPathDenied(policy, path.join(root, '.env.example')), false);
    assert.equal(isPathDenied(policy, path.join(root, '.env.sample')), false);
    assert.equal(isPathDenied(policy, path.join(root, '.env.template')), false);
    assert.equal(isPathDenied(policy, path.join(root, '.env.dist')), false);
    assert.equal(isPathDenied(policy, path.join(root, '.env.schema')), false);
    assert.equal(isPathDenied(policy, path.join(root, 'secrets.sops.yaml')), false);
    assert.equal(isPathDenied(policy, path.join(root, 'db.enc.json')), false);
    assert.equal(isPathDenied(policy, path.join(root, 'certs/server.pub')), false);
    assert.equal(isPathDenied(policy, path.join(root, 'src/index.mjs')), false);

    // Default named rule switches
    for (const ruleId of [
      'content:private-key',
      'content:unencrypted-sops',
      'content:npmrc-auth',
      'shell:file-read',
      'shell:sops-decrypt',
      'shell:env-dump',
      'shell:cli-secret-dump',
      'remote:ansible',
      'remote:terraform',
      'remote:terraform-plan',
      'remote:kubectl',
      'remote:kubectl-read',
      'remote:helm',
      'remote:helm-read',
      'remote:rclone',
      'remote:rclone-read',
    ]) {
      assert.equal(isRuleEnabled(policy, ruleId), true, `expected ${ruleId} enabled`);
      assert.equal(isRuleEnabled(policy, `@${ruleId}`), true, `expected @${ruleId} enabled`);
    }
  } finally {
    cleanup();
  }
});

test('supports last-match-wins precedence, repo-relative globs, blank-slate mode, and rule switch negations', () => {
  const { root, homeDir, cleanup } = makeRepoWithWorktree();
  try {
    mkdirSync(path.join(root, '.rig'), { recursive: true });

    // 1. @defaults followed by custom exemptions, custom denies, and strict positional precedence
    writeFileSync(
      path.join(root, '.rig/deny'),
      [
        '# comment line',
        '@defaults',
        'secrets/**',
        'wg/*.conf',
        'certs/explicit.sops.yaml',
        '!tests/fixtures/**',
        '!@remote:terraform-plan',
      ].join('\n') + '\n',
    );

    const policy = loadDenyPolicy({ cwd: root, homeDir, rigRoot: RIG_ROOT });
    assert.equal(isPathDenied(policy, path.join(root, 'secrets/prod/token.txt')), true);
    assert.equal(isPathDenied(policy, path.join(root, 'secrets'), { isDirectory: true }), true);
    assert.equal(isPathDenied(policy, path.join(root, 'wg/wg0.conf')), true);
    assert.equal(isPathDenied(policy, path.join(root, 'wg/sub/wg0.conf')), false);
    // Manual deny after @defaults overrides !*.sops.* from @defaults
    assert.equal(isPathDenied(policy, path.join(root, 'certs/explicit.sops.yaml')), true);
    // Manual negation after @defaults overrides *.key from @defaults
    assert.equal(isPathDenied(policy, path.join(root, 'tests/fixtures/dummy.key')), false);
    assert.equal(isRuleEnabled(policy, 'remote:terraform-plan'), false);
    assert.equal(isRuleEnabled(policy, 'remote:terraform'), true);

    // 2. Directory rule `secrets/` with specific file negation `!secrets/README.md`
    writeFileSync(
      path.join(root, '.rig/deny'),
      ['@defaults', 'secrets/', '!secrets/README.md'].join('\n') + '\n',
    );
    const dirPolicy = loadDenyPolicy({ cwd: root, homeDir, rigRoot: RIG_ROOT });
    assert.equal(isPathDenied(dirPolicy, path.join(root, 'secrets/api.txt')), true);
    assert.equal(isPathDenied(dirPolicy, path.join(root, 'secrets/README.md')), false);

    // 3. Blank-slate mode when .rig/deny omits @defaults
    writeFileSync(path.join(root, '.rig/deny'), 'only-this.secret\n@shell:file-read\n');
    const blankPolicy = loadDenyPolicy({ cwd: root, homeDir, rigRoot: RIG_ROOT });
    assert.equal(isPathDenied(blankPolicy, path.join(root, '.env')), false);
    assert.equal(isPathDenied(blankPolicy, path.join(root, 'only-this.secret')), true);
    assert.equal(isRuleEnabled(blankPolicy, 'shell:file-read'), true);
    assert.equal(isRuleEnabled(blankPolicy, 'remote:ansible'), false);
  } finally {
    cleanup();
  }
});

test('resolves stealth repoRoot .rig/deny across linked worktrees, prefers topLevel .rig/deny, and layers .rig/deny.local last', () => {
  const { root, wt, homeDir, cleanup } = makeRepoWithWorktree();
  try {
    mkdirSync(path.join(root, '.rig'), { recursive: true });
    // Untracked .rig/deny in main repoRoot (stealth mode)
    writeFileSync(path.join(root, '.rig/deny'), '@defaults\nstealth-secret.txt\n!@remote:helm-read\n');
    writeFileSync(path.join(root, '.rig/deny.local'), '!stealth-secret.txt\nlocal-only.secret\n');

    const wtPolicyFromStealth = loadDenyPolicy({ cwd: wt, homeDir, rigRoot: RIG_ROOT });
    assert.equal(isPathDenied(wtPolicyFromStealth, path.join(wt, 'stealth-secret.txt')), false);
    assert.equal(isPathDenied(wtPolicyFromStealth, path.join(wt, 'local-only.secret')), true);
    assert.equal(isRuleEnabled(wtPolicyFromStealth, 'remote:helm-read'), false);

    // Worktree-specific .rig/deny overrides main repoRoot .rig/deny while still appending .local
    mkdirSync(path.join(wt, '.rig'), { recursive: true });
    writeFileSync(path.join(wt, '.rig/deny'), '@defaults\nwt-only.secret\n');
    writeFileSync(path.join(wt, '.rig/deny.local'), '!wt-only.secret\n');

    const wtPolicyOverride = loadDenyPolicy({ cwd: wt, homeDir, rigRoot: RIG_ROOT });
    assert.equal(isPathDenied(wtPolicyOverride, path.join(wt, 'wt-only.secret')), false);
    assert.equal(isPathDenied(wtPolicyOverride, path.join(wt, 'local-only.secret')), true);
    assert.equal(isRuleEnabled(wtPolicyOverride, 'remote:helm-read'), true);
  } finally {
    cleanup();
  }
});

test('evaluates symlinks and search globs accurately', () => {
  const { root, homeDir, cleanup } = makeRepoWithWorktree();
  try {
    mkdirSync(path.join(root, '.rig'), { recursive: true });
    writeFileSync(path.join(root, '.rig/deny'), '@defaults\n!tests/fixtures/**\n');
    writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    mkdirSync(path.join(root, 'tests/fixtures'), { recursive: true });
    symlinkSync(path.join(root, '.env'), path.join(root, 'tests/fixtures/sneaky-link.txt'));

    const policy = loadDenyPolicy({ cwd: root, homeDir, rigRoot: RIG_ROOT });
    // Symlink pointing to .env is still denied even inside !tests/fixtures/**
    const linkEval = evaluatePath(policy, path.join(root, 'tests/fixtures/sneaky-link.txt'));
    assert.equal(linkEval.denied, true);

    // Search globs
    assert.equal(isSearchGlobDenied(policy, '.env'), true);
    assert.equal(isSearchGlobDenied(policy, '**/.env*'), true);
    assert.equal(isSearchGlobDenied(policy, '*.key'), true);
    assert.equal(isSearchGlobDenied(policy, '*.{ts,tfstate}'), true);
    assert.equal(isSearchGlobDenied(policy, '~/.ssh/id_*'), true);
    assert.equal(isSearchGlobDenied(policy, '*.ts'), false);
    assert.equal(isSearchGlobDenied(policy, '*.example'), false);
    assert.equal(isSearchGlobDenied(policy, '*.sops.yaml'), false);
    assert.equal(isSearchGlobDenied(policy, '!*.env'), false);
    assert.equal(isSearchGlobDenied(policy, '*'), false);

    // Policy file detection
    assert.equal(isDenyPolicyFile('.rig/deny', { cwd: root }), true);
    assert.equal(isDenyPolicyFile(path.join(root, '.rig/deny.local')), true);
    assert.equal(isDenyPolicyFile(path.join(root, 'src/deny')), false);
  } finally {
    cleanup();
  }
});
