import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateCommand, evaluateToolCall } from '../hooks/guard-secret-exposure.mjs';
import { checkEditTarget } from '../hooks/guard-main-checkout-edits.mjs';
import { parseHookInput } from '../hooks/lib/hook-io.mjs';
import {
  installRig,
  initRepo,
  checkRepoPendingUpdates,
  updateRepo,
  mergeClaudeSettings,
  buildHookCommand,
  rewriteDocLinks,
} from '../bin/rig.mjs';

const RIG_ROOT = path.resolve(import.meta.dirname, '..');
const HOOK = path.resolve(RIG_ROOT, 'hooks/guard-secret-exposure.mjs');
const EDIT_HOOK = path.resolve(RIG_ROOT, 'hooks/guard-main-checkout-edits.mjs');

function makeRiggedWorkspace({ worktrees = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-secret-repo-'));
  const unrigged = mkdtempSync(path.join(tmpdir(), 'rig-unrigged-repo-'));
  const homeDir = mkdtempSync(path.join(tmpdir(), 'rig-secret-home-'));

  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'README.md'), '# test\n');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/index.js'), 'export const ok = true;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');

  mkdirSync(path.join(root, '.rig/hooks'), { recursive: true });
  writeFileSync(path.join(root, '.rig/deny'), '@defaults\n');
  if (worktrees) {
    writeFileSync(path.join(root, '.rig/hooks/pre-commit'), '#!/bin/sh\nexit 0\n');
    git(root, 'config', 'core.hooksPath', '.rig/hooks');
  } else {
    writeFileSync(path.join(root, '.rig/hooks/guard-secret-exposure.mjs'), '// rigged\n');
  }

  let wt = root;
  if (worktrees) {
    wt = path.join(root, '.worktrees', 'feat-1');
    git(root, 'worktree', 'add', '-q', '-b', 'feature/feat-1', wt, 'main');
  }

  // Unrigged repo setup
  git(unrigged, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(unrigged, '.env'), 'UNRIGGED_SECRET=123\n');

  // Fake host credential stores inside homeDir
  mkdirSync(path.join(homeDir, '.ssh'), { recursive: true });
  writeFileSync(path.join(homeDir, '.ssh/id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n');
  writeFileSync(path.join(homeDir, '.ssh/id_ed25519.pub'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest\n');
  mkdirSync(path.join(homeDir, '.aws'), { recursive: true });
  writeFileSync(path.join(homeDir, '.aws/credentials'), '[default]\naws_secret_access_key=abc\n');
  mkdirSync(path.join(homeDir, '.config/sops/age'), { recursive: true });
  writeFileSync(path.join(homeDir, '.config/sops/age/keys.txt'), 'AGE-SECRET-KEY-1TEST\n');
  mkdirSync(path.join(homeDir, '.kube'), { recursive: true });
  writeFileSync(path.join(homeDir, '.kube/config'), 'apiVersion: v1\n');
  mkdirSync(path.join(homeDir, '.config/rclone'), { recursive: true });
  writeFileSync(path.join(homeDir, '.config/rclone/rclone.conf'), '[remote]\ntoken=abc\n');
  writeFileSync(path.join(homeDir, '.netrc'), 'machine example password secret\n');
  writeFileSync(path.join(homeDir, '.npmrc'), '//registry.npmjs.org/:_authToken=secret\n');

  return {
    root,
    wt,
    unrigged,
    homeDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(unrigged, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

function runHookBinary(hookPath, payload, harnessFlag = '--harness=antigravity') {
  const res = spawnSync(process.execPath, [hookPath, harnessFlag], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim() ? JSON.parse(res.stdout.trim()) : null;
}

test('unrigged repository isolation allows host/repo reads while rigged sessions protect $HOME and target paths', () => {
  const { root, wt, unrigged, homeDir, cleanup } = makeRiggedWorkspace();
  try {
    const opts = { homeDir, rigRoot: RIG_ROOT };

    // 1. Unrigged session has zero interference
    assert.equal(
      evaluateToolCall({ toolName: 'Read', filePath: path.join(unrigged, '.env'), cwd: unrigged }, opts).decision,
      'allow',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'read_file', filePath: '~/.ssh/id_ed25519', cwd: unrigged }, opts).decision,
      'allow',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'Grep', searchPath: path.join(homeDir, '.ssh'), cwd: unrigged }, opts).decision,
      'allow',
    );
    assert.equal(evaluateCommand('cat .env', unrigged, opts).decision, 'allow');
    assert.equal(evaluateCommand('env', unrigged, opts).decision, 'allow');
    assert.equal(evaluateCommand('sops -d secrets.sops.yaml', unrigged, opts).decision, 'allow');
    assert.equal(evaluateCommand('kubectl get secret -o yaml', unrigged, opts).decision, 'allow');

    // 2. Unrigged cwd targeting a rigged repository path is guarded
    writeFileSync(path.join(root, '.env'), 'API_KEY=secret\n');
    assert.equal(
      evaluateToolCall({ toolName: 'Read', filePath: path.join(root, '.env'), cwd: unrigged }, opts).decision,
      'deny',
    );
    assert.equal(
      evaluateCommand(`cat "${path.join(root, '.env')}"`, unrigged, opts).decision,
      'deny',
    );
    assert.equal(
      evaluateCommand(`cd "${wt}" && cat "${path.join(root, '.env')}"`, unrigged, opts).decision,
      'deny',
    );

    // 3. Rigged session protects $HOME credential stores (even across cd) while allowing .pub keys
    for (const hostSecret of [
      '~/.ssh/id_ed25519',
      path.join(homeDir, '.ssh/id_ed25519'),
      '~/.aws/credentials',
      '~/.config/sops/age/keys.txt',
      '~/.kube/config',
      '~/.config/rclone/rclone.conf',
      '~/.netrc',
      '~/.npmrc',
      '~/.pypirc',
      '~/.docker/config.json',
      '~/.config/gh/hosts.yml',
    ]) {
      const res = evaluateToolCall({ toolName: 'view_file', filePath: hostSecret, cwd: wt }, opts);
      assert.equal(res.decision, 'deny', `expected deny for ${hostSecret}`);
      assert.match(res.reason, /skills\/secure-credential-handoff\/SKILL\.md/);
    }

    assert.equal(
      evaluateToolCall({ toolName: 'view_file', filePath: '~/.ssh/id_ed25519.pub', cwd: wt }, opts).decision,
      'allow',
    );
    assert.equal(
      evaluateCommand(`cd "${path.join(homeDir, '.ssh')}" && cat id_ed25519`, wt, opts).decision,
      'deny',
    );
  } finally {
    cleanup();
  }
});

test('file-read and search matchers enforce .rig/deny globs, directory searches, and @content:* inspections', () => {
  const { root, wt, homeDir, cleanup } = makeRiggedWorkspace();
  try {
    const opts = { homeDir, rigRoot: RIG_ROOT };
    writeFileSync(path.join(wt, '.env'), 'SECRET=super-secret-value\n');
    writeFileSync(path.join(wt, '.env.example'), 'SECRET=\n');
    writeFileSync(path.join(wt, 'terraform.tfstate'), '{"resources":[]}\n');
    mkdirSync(path.join(wt, 'certs'), { recursive: true });
    writeFileSync(
      path.join(wt, 'certs/ca.pem'),
      '-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END CERTIFICATE-----\n',
    );
    writeFileSync(
      path.join(wt, 'certs/server.pem'),
      '-----BEGIN RSA PRIVATE KEY-----\nPRIVATE_BODY_DO_NOT_ECHO\n-----END RSA PRIVATE KEY-----\n',
    );
    writeFileSync(path.join(wt, 'secrets.sops.yaml'), 'db:\n  password: ENC[AES256_GCM,data:abc]\n');
    writeFileSync(path.join(wt, 'plain.sops.yaml'), 'db:\n  password: unencrypted-plaintext\n');
    writeFileSync(path.join(wt, 'empty.sops.yaml'), '');
    writeFileSync(path.join(wt, 'vault.enc.yml'), '$ANSIBLE_VAULT;1.1;AES256\n313233\n');
    writeFileSync(path.join(wt, 'plain.enc.json'), '{"token": "plaintext"}\n');
    writeFileSync(path.join(wt, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_secret_123\n');
    mkdirSync(path.join(wt, 'pkg'), { recursive: true });
    writeFileSync(path.join(wt, 'pkg/.npmrc'), 'registry=https://registry.npmjs.org/\n');

    // Read tools across Antigravity & Claude
    for (const toolName of ['read_file', 'view_file', 'view_file_outline', 'view_code_item', 'Read']) {
      assert.equal(
        evaluateToolCall({ toolName, filePath: path.join(wt, '.env'), cwd: wt }, opts).decision,
        'deny',
      );
      assert.equal(
        evaluateToolCall({ toolName, filePath: path.join(wt, '.env.example'), cwd: wt }, opts).decision,
        'allow',
      );
    }

    // @content:private-key
    assert.equal(
      evaluateToolCall({ toolName: 'read_file', filePath: path.join(wt, 'certs/ca.pem'), cwd: wt }, opts).decision,
      'allow',
    );
    const keyRes = evaluateToolCall({ toolName: 'read_file', filePath: path.join(wt, 'certs/server.pem'), cwd: wt }, opts);
    assert.equal(keyRes.decision, 'deny');
    assert.equal(keyRes.reason.includes('PRIVATE_BODY_DO_NOT_ECHO'), false);

    // @content:unencrypted-sops
    assert.equal(
      evaluateToolCall({ toolName: 'Read', filePath: path.join(wt, 'secrets.sops.yaml'), cwd: wt }, opts).decision,
      'allow',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'Read', filePath: path.join(wt, 'vault.enc.yml'), cwd: wt }, opts).decision,
      'allow',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'Read', filePath: path.join(wt, 'empty.sops.yaml'), cwd: wt }, opts).decision,
      'allow',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'Read', filePath: path.join(wt, 'plain.sops.yaml'), cwd: wt }, opts).decision,
      'deny',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'Read', filePath: path.join(wt, 'plain.enc.json'), cwd: wt }, opts).decision,
      'deny',
    );

    // @content:npmrc-auth
    assert.equal(
      evaluateToolCall({ toolName: 'Read', filePath: path.join(wt, '.npmrc'), cwd: wt }, opts).decision,
      'deny',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'Read', filePath: path.join(wt, 'pkg/.npmrc'), cwd: wt }, opts).decision,
      'allow',
    );

    // Search checks (grep_search / Grep)
    assert.equal(
      evaluateToolCall({ toolName: 'Grep', searchPath: wt, searchGlobs: ['*.js'], cwd: wt }, opts).decision,
      'allow',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'grep_search', searchPath: path.join(wt, 'src'), searchGlobs: [], cwd: wt }, opts).decision,
      'allow',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'Grep', searchPath: wt, searchGlobs: ['**/.env*'], cwd: wt }, opts).decision,
      'deny',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'grep_search', searchPath: wt, searchGlobs: ['*.{ts,tfstate}'], cwd: wt }, opts).decision,
      'deny',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'Grep', searchPath: path.join(homeDir, '.ssh'), searchGlobs: [], cwd: wt }, opts).decision,
      'deny',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'Grep', searchPath: '~/.config/sops/age', searchGlobs: [], cwd: wt }, opts).decision,
      'deny',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'Grep', searchPath: path.join(wt, 'certs/server.pem'), searchGlobs: [], cwd: wt }, opts).decision,
      'deny',
    );

    // Custom .rig/deny dir + positional override of !*.sops.*
    mkdirSync(path.join(wt, 'secrets/prod'), { recursive: true });
    writeFileSync(path.join(wt, 'secrets/prod/token.txt'), 'tok\n');
    writeFileSync(path.join(root, '.rig/deny'), '@defaults\nsecrets/**\nsecrets.sops.yaml\n');
    assert.equal(
      evaluateToolCall({ toolName: 'Grep', searchPath: path.join(wt, 'secrets'), searchGlobs: [], cwd: wt }, opts).decision,
      'deny',
    );
    // Explicit deny in .rig/deny overrides ciphertext heuristic
    assert.equal(
      evaluateToolCall({ toolName: 'Read', filePath: path.join(wt, 'secrets.sops.yaml'), cwd: wt }, opts).decision,
      'deny',
    );

    // Blank-slate .rig/deny without @defaults
    writeFileSync(path.join(root, '.rig/deny'), 'only-this.secret\n');
    assert.equal(
      evaluateToolCall({ toolName: 'Read', filePath: path.join(wt, '.env'), cwd: wt }, opts).decision,
      'allow',
    );
    assert.equal(
      evaluateToolCall({ toolName: 'Read', filePath: path.join(wt, 'only-this.secret'), cwd: wt }, opts).decision,
      'deny',
    );
  } finally {
    cleanup();
  }
});

test('@shell:* rules catch file reads, sops/ansible-vault leaks, env dumps, and CLI secret dumps', () => {
  const { wt, homeDir, cleanup } = makeRiggedWorkspace();
  try {
    const opts = { homeDir, rigRoot: RIG_ROOT };
    writeFileSync(path.join(wt, '.env'), 'API_KEY=secret\n');
    writeFileSync(path.join(wt, '.env.local'), 'API_KEY=local\n');
    writeFileSync(path.join(wt, '.env.example'), 'API_KEY=\n');
    writeFileSync(path.join(wt, 'secrets.sops.yaml'), 'key: ENC[AES256_GCM,data:123]\n');
    writeFileSync(path.join(wt, 'plain.sops.yaml'), 'key: plaintext\n');
    mkdirSync(path.join(wt, 'certs'), { recursive: true });
    writeFileSync(
      path.join(wt, 'certs/server.pem'),
      '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n',
    );

    // @shell:file-read denies stdout readers & input redirections
    for (const cmd of [
      'cat .env',
      'head -n 5 .env',
      'tail ~/.aws/credentials',
      'less .env',
      'more .env',
      'bat .env',
      'nl .env',
      'grep API_KEY .env',
      'rg API_KEY .env',
      "sed -n '1p' .env",
      "awk '{print}' .env",
      'cut -d= -f2 .env',
      'strings ~/.ssh/id_ed25519',
      'base64 .env',
      'xxd .env',
      'hexdump .env',
      'od .env',
      'jq . plain.sops.yaml',
      'yq . certs/server.pem',
      'cat < .env',
      'jq . < .env',
      'echo $(cat .env)',
      'bash -c "cat .env"',
      'env -i cat .env',
      'grep -q -o API_KEY .env',
      'rg -q --passthru API_KEY .env',
      'grep -q -A 2 API_KEY .env',
    ]) {
      assert.equal(evaluateCommand(cmd, wt, opts).decision, 'deny', `expected deny for: ${cmd}`);
    }

    // @shell:file-read allows zero-stdout grep -q / rg -q and safe files
    for (const cmd of [
      "grep -q '^API_KEY=' .env",
      "rg -q '^API_KEY=' .env.local",
      "grep -qi --quiet '^api_key=' .env",
      'cat .env.example',
      "jq 'keys' secrets.sops.yaml",
    ]) {
      assert.equal(evaluateCommand(cmd, wt, opts).decision, 'allow', `expected allow for: ${cmd}`);
    }

    // @shell:sops-decrypt
    for (const cmd of [
      'sops -d secrets.sops.yaml',
      'sops --decrypt secrets.sops.yaml',
      'sops decrypt secrets.sops.yaml',
      'sops -ds secrets.sops.yaml',
      'sops -d secrets.sops.yaml 2>/dev/null',
      'sops -d secrets.sops.yaml | jq .',
      'sops -d secrets.sops.yaml | cat',
      'sops -d secrets.sops.yaml | grep key',
      'sops -d secrets.sops.yaml | tee out.yaml',
      'ansible-vault view vault.yml',
      'ansible-vault decrypt vault.yml',
      'ansible-vault decrypt --output=- vault.yml',
      "sops exec-env secrets.sops.yaml 'env'",
      "sops exec-env secrets.sops.yaml 'printenv API_KEY'",
      "sops exec-file secrets.sops.yaml 'cat {}'",
    ]) {
      assert.equal(evaluateCommand(cmd, wt, opts).decision, 'deny', `expected deny for: ${cmd}`);
    }

    for (const cmd of [
      'sops -d secrets.sops.yaml >/dev/null',
      'sops -d secrets.sops.yaml &>/dev/null',
      'sops -d secrets.sops.yaml >/dev/null 2>&1',
      'ansible-vault view vault.yml >/dev/null',
      'ansible-vault decrypt --output /dev/null vault.yml',
      "sops exec-env secrets.sops.yaml './deploy.sh'",
      "sops exec-file secrets.sops.yaml './run-with-file {}'",
    ]) {
      assert.equal(evaluateCommand(cmd, wt, opts).decision, 'allow', `expected allow for: ${cmd}`);
    }

    for (const cmd of [
      'sops -d secrets.sops.yaml | kubectl apply -f -',
      'sops -d secrets.sops.yaml > out.yaml',
      'sops -d --output out.yaml secrets.sops.yaml',
      'ansible-vault view vault.yml | kubectl apply -f -',
      'ansible-vault decrypt --output plain.yml vault.yml',
    ]) {
      assert.equal(evaluateCommand(cmd, wt, opts).decision, 'ask', `expected ask for: ${cmd}`);
    }

    // Combined ask + deny => deny takes precedence
    assert.equal(
      evaluateCommand('sops -d secrets.sops.yaml | kubectl apply -f - && cat .env', wt, opts).decision,
      'deny',
    );

    // @shell:env-dump
    for (const cmd of [
      'env',
      'sudo env',
      'env -i',
      'env FOO=1',
      'printenv',
      'printenv API_KEY',
      'printenv AWS_SECRET_ACCESS_KEY',
      'export -p',
      'declare -xp',
      'declare -p',
      'typeset -p',
      'set',
      'set -x && source .env',
      'set -o xtrace; . .env',
      'bash -x -c "source .env"',
      'sh -xc ". .env"',
      'bash -x .env',
    ]) {
      assert.equal(evaluateCommand(cmd, wt, opts).decision, 'deny', `expected deny for: ${cmd}`);
    }

    for (const cmd of [
      'env NODE_ENV=test node app.js',
      'env -i PATH=/usr/bin node app.js',
      'printenv PATH',
      'export FOO=bar',
      'set -a && source .env.local && set +a && ./run-app',
      'set -x; set +x; source .env',
    ]) {
      assert.equal(evaluateCommand(cmd, wt, opts).decision, 'allow', `expected allow for: ${cmd}`);
    }

    // @shell:cli-secret-dump
    for (const cmd of [
      'rclone config show',
      'rclone config dump',
      'kubectl get secret -o yaml',
      'kubectl get secrets -n prod -o json',
      "kubectl get secret/db-creds -o jsonpath='{.data}'",
      "kubectl get secret -o go-template='{{.data}}'",
      'kubectl get secret -o custom-columns=NAME:.metadata.name,DATA:.data',
      'kubectl get secret -o template',
      'kubectl config view --raw',
      'terraform state pull',
      'tofu state pull',
      'terraform output -json',
      'tofu output -raw db_password',
    ]) {
      assert.equal(evaluateCommand(cmd, wt, opts).decision, 'deny', `expected deny for: ${cmd}`);
    }

    for (const cmd of [
      'kubectl get secrets',
      'kubectl get secrets -n prod',
      'kubectl config view',
      'terraform output',
      'rclone listremotes',
    ]) {
      assert.equal(evaluateCommand(cmd, wt, opts).decision, 'allow', `expected allow for: ${cmd}`);
    }
  } finally {
    cleanup();
  }
});

test('hardcoded anti-tamper unconditionally protects .rig/deny and .rig/deny.local across main, worktrees, and blank-slate mode', () => {
  const { root, wt, homeDir, cleanup } = makeRiggedWorkspace();
  try {
    const opts = { homeDir, rigRoot: RIG_ROOT };
    // Even with a blank-slate .rig/deny omitting @defaults and disabling @shell:* rules
    mkdirSync(path.join(wt, '.rig'), { recursive: true });
    writeFileSync(path.join(root, '.rig/deny'), '# blank slate\n');
    writeFileSync(path.join(wt, '.rig/deny'), '# blank slate\n');
    writeFileSync(path.join(wt, '.rig/deny.local'), '# local\n');

    // 1. guard-main-checkout-edits.mjs blocks edits in BOTH main checkout and worktrees
    assert.match(
      checkEditTarget(path.join(root, '.rig/deny'), { cwd: root, harness: 'antigravity', homeDir }) || '',
      /only be edited directly by the user/i,
    );
    assert.match(
      checkEditTarget(path.join(wt, '.rig/deny'), { cwd: wt, harness: 'claude', homeDir }) || '',
      /only be edited directly by the user/i,
    );
    assert.match(
      checkEditTarget(path.join(wt, '.rig/deny.local'), { cwd: wt, harness: 'claude', homeDir }) || '',
      /only be edited directly by the user/i,
    );

    // 2. guard-secret-exposure.mjs blocks edit_file/write_file/Edit/Write on .rig/deny & .rig/deny.local
    for (const toolName of ['edit_file', 'write_file', 'Edit', 'Write']) {
      assert.equal(
        evaluateToolCall({ toolName, filePath: path.join(wt, '.rig/deny'), cwd: wt }, opts).decision,
        'deny',
      );
      assert.equal(
        evaluateToolCall({ toolName, filePath: path.join(root, '.rig/deny.local'), cwd: root }, opts).decision,
        'deny',
      );
    }

    // 3. guard-secret-exposure.mjs blocks shell mutations targeting .rig/deny or .rig/deny.local
    for (const cmd of [
      'echo "" > .rig/deny',
      'echo "!*.env" >> .rig/deny.local',
      'echo "" | tee .rig/deny',
      'rm .rig/deny',
      'unlink .rig/deny.local',
      'truncate -s 0 .rig/deny',
      'dd if=/dev/zero of=.rig/deny',
      'cp /tmp/empty .rig/deny',
      'mv .rig/deny /tmp/backup',
      'ln -sf /tmp/empty .rig/deny',
      "sed -i 'd' .rig/deny",
      "perl -i -pe '' .rig/deny",
      'touch .rig/deny.local',
      'git rm .rig/deny',
    ]) {
      assert.equal(evaluateCommand(cmd, wt, opts).decision, 'deny', `expected deny for tamper cmd: ${cmd}`);
    }

    // Reading .rig/deny itself is allowed so agents can inspect active rules
    assert.equal(evaluateToolCall({ toolName: 'Read', filePath: path.join(wt, '.rig/deny'), cwd: wt }, opts).decision, 'allow');
    assert.equal(evaluateCommand('cat .rig/deny', wt, opts).decision, 'allow');

    // End-to-end check on guard-main-checkout-edits.mjs CLI in worktree
    const editCliOut = runHookBinary(
      EDIT_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(wt, '.rig/deny') },
        cwd: wt,
      },
      '--harness=claude',
    );
    assert.equal(editCliOut.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    cleanup();
  }
});

test('end-to-end hook binary handles Antigravity and Claude Code payloads and CLI installation wires guard-secret-exposure', () => {
  const { wt, unrigged, homeDir, cleanup } = makeRiggedWorkspace();
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-install-claude-'));
  const claudeRepo = mkdtempSync(path.join(tmpdir(), 'rig-init-claude-secret-'));
  try {
    writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');

    // Antigravity Read/Grep/Edit/Bash CLI
    const agyRead = runHookBinary(HOOK, {
      workspacePaths: [wt],
      toolCall: { name: 'view_file', args: { AbsolutePath: path.join(wt, '.env') } },
    });
    assert.equal(agyRead.decision, 'deny');

    const agyGrepAllow = runHookBinary(HOOK, {
      workspacePaths: [wt],
      toolCall: { name: 'grep_search', args: { SearchPath: wt, Includes: ['*.js'], Query: 'ok' } },
    });
    assert.equal(agyGrepAllow.decision, 'allow');

    const agyUnrigged = runHookBinary(HOOK, {
      workspacePaths: [unrigged],
      toolCall: { name: 'view_file', args: { AbsolutePath: path.join(unrigged, '.env') } },
    });
    assert.equal(agyUnrigged.decision, 'allow');

    // Claude Code CLI
    const claudeBashDeny = runHookBinary(
      HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'sops -d secrets.sops.yaml' },
        cwd: wt,
      },
      '--harness=claude',
    );
    assert.equal(claudeBashDeny.hookSpecificOutput.permissionDecision, 'deny');

    const claudeBashAsk = runHookBinary(
      HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'sops -d secrets.sops.yaml | kubectl apply -f -' },
        cwd: wt,
      },
      '--harness=claude',
    );
    assert.equal(claudeBashAsk.hookSpecificOutput.permissionDecision, 'ask');

    const claudeReadAllow = runHookBinary(
      HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: path.join(wt, 'src/index.js') },
        cwd: wt,
      },
      '--harness=claude',
    );
    assert.equal(claudeReadAllow, null);

    // parseHookInput normalizes extra generic/antigravity fields
    const genericParsed = parseHookInput(
      JSON.stringify({
        toolName: 'view_code_item',
        toolArgs: { File: path.join(wt, '.env') },
        cwd: wt,
      }),
    );
    assert.equal(genericParsed.filePath, path.join(wt, '.env'));

    // installRig wires guard-secret-exposure.mjs into ~/.claude/settings.json and ~/.claude/hooks/
    installRig({ harnesses: ['claude'], homeDir: fakeHome, rigRoot: RIG_ROOT });
    assert.ok(existsSync(path.join(fakeHome, '.claude/hooks/guard-secret-exposure.mjs')));
    const settings = JSON.parse(readFileSync(path.join(fakeHome, '.claude/settings.json'), 'utf8'));
    const matchers = settings.hooks.PreToolUse.map((g) => g.matcher);
    assert.deepEqual(matchers, ['Bash', 'Edit|Write', 'Read|Grep']);
    for (const g of settings.hooks.PreToolUse) {
      assert.ok(g.hooks.some((h) => h.command.includes('guard-secret-exposure.mjs')));
    }

    // mergeClaudeSettings deduplicates guard-secret-exposure.mjs cleanly
    const remerged = mergeClaudeSettings(settings, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read|Grep',
            hooks: [
              {
                type: 'command',
                command: buildHookCommand(path.join(fakeHome, '.claude/hooks/guard-secret-exposure.mjs'), '--harness=claude', {
                  nodeBin: '/custom/node',
                }),
              },
            ],
          },
        ],
      },
    });
    const readGrepHooks = remerged.hooks.PreToolUse.find((g) => g.matcher === 'Read|Grep').hooks;
    assert.equal(readGrepHooks.length, 1);
    assert.match(readGrepHooks[0].command, /\/custom\/node/);

    // rewriteDocLinks maps `hooks/guard-secret-exposure.mjs` for .gemini/.claude dot-dirs
    assert.equal(
      rewriteDocLinks('See `hooks/guard-secret-exposure.mjs`.', { isDotHarness: true }),
      'See `.rig/hooks/guard-secret-exposure.mjs`.',
    );

    // initRepo + checkRepoPendingUpdates + updateRepo vendor guard-secret-exposure.mjs
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: claudeRepo });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: claudeRepo });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: claudeRepo });
    initRepo(claudeRepo, { selfContained: true, worktrees: true, harness: 'claude', homeDir: false });
    assert.ok(existsSync(path.join(claudeRepo, '.rig/hooks/guard-secret-exposure.mjs')));
    assert.ok(existsSync(path.join(claudeRepo, '.claude/hooks/guard-secret-exposure.mjs')));
    const repoSettings = JSON.parse(readFileSync(path.join(claudeRepo, '.claude/settings.json'), 'utf8'));
    assert.ok(repoSettings.hooks.PreToolUse.some((g) => g.matcher === 'Read|Grep'));

    spawnSync('git', ['add', '-A'], { cwd: claudeRepo });
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: claudeRepo });
    rmSync(path.join(claudeRepo, '.rig/hooks/guard-secret-exposure.mjs'));
    spawnSync('git', ['add', '-A'], { cwd: claudeRepo });
    spawnSync('git', ['commit', '-qm', 'remove guard'], { cwd: claudeRepo });

    const pending = checkRepoPendingUpdates(claudeRepo, { harness: 'claude', rigRoot: RIG_ROOT });
    assert.equal(pending.hasPendingUpdates, true);
    assert.ok(pending.pendingFiles.some((f) => f.endsWith('.rig/hooks/guard-secret-exposure.mjs')));

    const upd = updateRepo(claudeRepo, { harness: 'claude', autoCommit: true, rigRoot: RIG_ROOT });
    assert.equal(upd.committed, true, upd.commitError);
    assert.ok(existsSync(path.join(claudeRepo, '.rig/hooks/guard-secret-exposure.mjs')));
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(claudeRepo, { recursive: true, force: true });
  }
});
