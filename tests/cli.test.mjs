import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, rmSync, readdirSync, copyFileSync, chmodSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RIG_ROOT,
  ROLES,
  detectHarnesses,
  installRig,
  updateRig,
  readRigState,
  initRepo,
  updateRepo,
  detectRepoHarness,
  rewriteDocLinks,
  statusRepo,
  runCheckDocs,
  runReflowDocs,
  normalizeGitignore,
  attachMainCheckout,
  INIT_WORKTREE_BRANCH,
  loadCatalog,
  resolveSubagentModel,
  resolveProfile,
  hydrateText,
  listProfiles,
  useProfile,
  setProfileRole,
  resolveRoleModel,
  buildRigWrapperScript,
  resolveNodeBinary,
  buildHookCommand,
  hydrateAntigravityHooksJson,
  linkSafe,
  mergeClaudeSettings,
  DEFAULT_SYSTEM_PATH,
  detectExistingHookManager,
  getHookChainingGuidance,
  buildNodeFallbackShell,
  attachRepo,
  ejectRepo,
  writeRigState,
  isSelfContainedRepo,
  validateRepoCleanForUpdate,
  checkRepoPendingUpdates,
  VENDORED_RIG_FILES,
  listSkills,
  isIgnoredFsEntry,
} from '../bin/rig.mjs';
import { isRiggedRepo } from '../hooks/guard-main-checkout-edits.mjs';

function makeRepoWithHistory(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'README.md'), '# legacy\n\nSee [`AGENTS.md`](AGENTS.md).\n');
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n*.log\n');
  writeFileSync(path.join(root, 'app.js'), 'console.log(1);\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'initial');
  mkdirSync(path.join(root, 'node_modules'));
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('normalizeGitignore ignores .worktrees/ and drops the trailing slash from node_modules/', () => {
  assert.deepEqual(normalizeGitignore('node_modules/\n*.log\n'), {
    content: 'node_modules\n*.log\n.worktrees/\n',
    changed: true,
  });
  assert.deepEqual(normalizeGitignore('/node_modules/\n'), { content: '/node_modules\n.worktrees/\n', changed: true });
  assert.deepEqual(normalizeGitignore('node_modules\n.worktrees/\n'), {
    content: 'node_modules\n.worktrees/\n',
    changed: false,
  });
  assert.deepEqual(normalizeGitignore(''), { content: '.worktrees/\n', changed: true });
});

test('attachMainCheckout re-attaches a detached clean checkout to main and detects dirty state', () => {
  const { root, cleanup } = makeRepoWithHistory('rig-attach-');
  try {
    // Detach HEAD first
    spawnSync('git', ['switch', '--detach', 'main'], { cwd: root });
    assert.equal(attachMainCheckout(root).status, 'attached');
    assert.equal(spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), 'main');

    // Already attached returns already-attached
    assert.equal(attachMainCheckout(root).status, 'already-attached');

    // Detached with tracked edits reports dirty
    spawnSync('git', ['switch', '--detach', 'main'], { cwd: root });
    writeFileSync(path.join(root, 'app.js'), 'console.log(2);\n');
    assert.equal(attachMainCheckout(root).status, 'dirty');
  } finally {
    cleanup();
  }
});

test('initRepo on a main checkout with history scaffolds into a linked worktree that can commit', () => {
  const { root, git, cleanup } = makeRepoWithHistory('rig-init-history-');
  try {
    const res = initRepo(root, { worktrees: true });
    const wt = path.join(root, '.worktrees/rig-init');
    assert.equal(res.initWorktree.path, wt);
    assert.equal(res.initWorktree.branch, INIT_WORKTREE_BRANCH);
    assert.equal(res.dir, wt);
    assert.equal(res.hooksConfigured, true);

    // Scaffolding lands in the worktree, never in the main checkout.
    assert.ok(existsSync(path.join(wt, 'AGENTS.md')));
    assert.ok(existsSync(path.join(wt, '.rig/hooks/pre-commit')));
    assert.equal(existsSync(path.join(wt, '.rig/hooks/pre-merge-commit')), false);
    assert.equal(existsSync(path.join(root, 'AGENTS.md')), false);

    // The worktree shares node_modules through a symlink, and .gitignore covers both it and .worktrees/.
    assert.ok(lstatSync(path.join(wt, 'node_modules')).isSymbolicLink());
    assert.equal(readFileSync(path.join(wt, '.gitignore'), 'utf8'), 'node_modules\n*.log\n.worktrees/\n');

    // The main checkout stays attached to main, and the worktree stays on its branch.
    assert.equal(res.mainCheckoutHead.status, 'already-attached');
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), 'main');
    assert.equal(git(wt, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), INIT_WORKTREE_BRANCH);

    // Everything written is staged, so the doc linters pass and the next step is a plain commit.
    assert.ok(res.staged.includes('AGENTS.md'));
    assert.ok(res.staged.includes('.gitignore'));
    assert.equal(git(wt, 'status', '--porcelain').stdout.trim().split('\n').every((l) => l.startsWith('A ') || l.startsWith('M ')), true);
    const checkLinks = runCheckDocs(wt);
    assert.equal(checkLinks.status, 0, `${checkLinks.stdout}${checkLinks.stderr}`);

    const commit = git(wt, 'commit', '-qm', 'chore(rig): initialize agent-rig');
    assert.equal(commit.status, 0, commit.stderr);

    // Running rig init again reuses the worktree instead of failing.
    const again = initRepo(root, { worktrees: true });
    assert.equal(again.initWorktree.reused, true);
  } finally {
    cleanup();
  }
});

test('initRepo on a repository without README does not scaffold README.md', () => {
  const { root, git, cleanup } = makeRepoWithHistory('custom-service-');
  try {
    git(root, 'rm', '-q', 'README.md');
    git(root, 'commit', '-qm', 'remove legacy readme');
    const res = initRepo(root, { worktrees: true });
    const wt = res.initWorktree.path;
    assert.equal(existsSync(path.join(wt, 'README.md')), false);
  } finally {
    cleanup();
  }
});

test('initRepo targeting a linked worktree scaffolds in place and leaves the main checkout attached', () => {
  const { root, git, cleanup } = makeRepoWithHistory('rig-init-linked-');
  try {
    const wt = path.join(root, '.worktrees/onboard');
    git(root, 'worktree', 'add', '-q', '-b', 'chore/onboard', wt, 'main');
    const res = initRepo(wt, { worktrees: true });
    assert.equal(res.initWorktree, null);
    assert.equal(res.dir, wt);
    assert.ok(existsSync(path.join(wt, 'AGENTS.md')));
    assert.equal(res.mainCheckoutHead.status, 'already-attached');
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), 'main');
    assert.equal(git(wt, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), 'chore/onboard');
  } finally {
    cleanup();
  }
});

test('detectHarnesses, installRig, and updateRig manage state, hydrate roles, and prune dangling symlinks', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-'));
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });

    const detected = detectHarnesses(fakeHome);
    assert.equal(detected.find((h) => h.id === 'antigravity').detected, true);
    assert.equal(detected.find((h) => h.id === 'claude').detected, true);
    assert.equal(detected.find((h) => h.id === 'codex').detected, false);

    const res = installRig({ homeDir: fakeHome, detectedOnly: true });
    assert.deepEqual(res.installedHarnesses, ['antigravity', 'claude']);
    const wrapperBin = path.join(fakeHome, '.local/bin/rig');
    assert.ok(existsSync(wrapperBin) && !lstatSync(wrapperBin).isSymbolicLink());
    assert.match(readFileSync(wrapperBin, 'utf8'), /exec /);

    // Invoking rig via wrapper script must execute main()
    const cliRun = spawnSync(wrapperBin, ['status', RIG_ROOT], { encoding: 'utf8' });
    assert.equal(cliRun.status, 0, cliRun.stderr);
    assert.equal(JSON.parse(cliRun.stdout).hasAgentsMd, true);

    const state = readRigState(fakeHome);
    assert.deepEqual(state.installedHarnesses, ['antigravity', 'claude']);
    assert.ok(state.installedSkills.includes('dispatch'));
    assert.ok(state.nodeBin);

    // Antigravity plugin directory with hydrated files, symlinked hooks, and plugins.json
    const agyPluginDir = path.join(fakeHome, '.gemini/config/plugins/agent-rig');
    assert.equal(lstatSync(agyPluginDir).isSymbolicLink(), false);
    assert.ok(lstatSync(path.join(agyPluginDir, 'hooks')).isSymbolicLink());
    assert.equal(existsSync(path.join(agyPluginDir, 'rules/AGENTS.md')), false);
    assert.ok(existsSync(path.join(agyPluginDir, 'rules/contract-change-gate.md')));
    assert.ok(existsSync(path.join(agyPluginDir, 'rules/ui-change-gate.md')));
    const agyVerifier = readFileSync(path.join(agyPluginDir, 'agents/verifier.md'), 'utf8');
    assert.match(agyVerifier, /gemini-3-8-flash/);
    assert.equal(agyVerifier.includes('{{'), false);
    const agyWorker = readFileSync(path.join(agyPluginDir, 'agents/worker.md'), 'utf8');
    assert.match(agyWorker, /gemini-3-8-flash/);
    assert.equal(agyWorker.includes('{{'), false);
    assert.ok(existsSync(path.join(agyPluginDir, 'rules/contract-change-gate.md')));
    const pluginsJson = JSON.parse(readFileSync(path.join(fakeHome, '.gemini/config/plugins.json'), 'utf8'));
    assert.equal(pluginsJson.entries.length, 1);
    const agyHooks = JSON.parse(readFileSync(path.join(agyPluginDir, 'hooks.json'), 'utf8'));
    assert.match(agyHooks['remote-mutation-guard'].PreToolUse[0].hooks[0].command, /Run 'rig update'/);

    // Claude hydrated skills, verifier subagent, and settings.json
    assert.equal(lstatSync(path.join(fakeHome, '.claude/skills/dispatch')).isSymbolicLink(), false);
    const claudeSkill = readFileSync(path.join(fakeHome, '.claude/skills/dispatch/SKILL.md'), 'utf8');
    assert.match(claudeSkill, /claude-sonnet-5-5/);
    assert.equal(claudeSkill.includes('{{'), false);
    const claudeVerifier = readFileSync(path.join(fakeHome, '.claude/agents/verifier.md'), 'utf8');
    assert.match(claudeVerifier, /model: sonnet/);
    assert.equal(claudeVerifier.includes('{{'), false);
    const claudeWorker = readFileSync(path.join(fakeHome, '.claude/agents/worker.md'), 'utf8');
    assert.match(claudeWorker, /model: sonnet/);
    assert.equal(claudeWorker.includes('{{'), false);
    assert.ok(existsSync(path.join(fakeHome, '.claude/rules/contract-change-gate.md')));
    const claudeSettings = JSON.parse(readFileSync(path.join(fakeHome, '.claude/settings.json'), 'utf8'));
    assert.equal(claudeSettings.hooks.PreToolUse.length, 2);
    assert.match(claudeSettings.hooks.PreToolUse[0].hooks[0].command, /Run 'rig update'/);

    // Plant a dangling symlink and verify updateRig prunes it without prompting
    const dangling = path.join(fakeHome, '.claude/hooks/removed-hook');
    symlinkSync(path.join(RIG_ROOT, 'hooks/does-not-exist'), dangling);
    assert.ok(lstatSync(dangling).isSymbolicLink());

    const upd = updateRig({ homeDir: fakeHome, nodeBin: '/mock/node/updated' });
    assert.deepEqual(upd.installedHarnesses, ['antigravity', 'claude']);
    assert.deepEqual(upd.pruned, [dangling]);
    assert.equal(existsSync(dangling), false);
    assert.equal(upd.linked.length, 0);
    assert.ok(upd.skipped.length >= 1);

    const updatedAgyHooks = JSON.parse(readFileSync(path.join(agyPluginDir, 'hooks.json'), 'utf8'));
    assert.match(updatedAgyHooks['remote-mutation-guard'].PreToolUse[0].hooks[0].command, /NODE="\/mock\/node\/updated"/);
    const updatedClaudeSettings = JSON.parse(readFileSync(path.join(fakeHome, '.claude/settings.json'), 'utf8'));
    assert.equal(updatedClaudeSettings.hooks.PreToolUse[0].hooks.length, 2);
    assert.match(updatedClaudeSettings.hooks.PreToolUse[0].hooks[0].command, /NODE="\/mock\/node\/updated"/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('linkSafe and updateRig are idempotent and do not recreate or re-count existing valid symlinks', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-idempotent-'));
  const testDir = mkdtempSync(path.join(tmpdir(), 'rig-linksafe-'));
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    const first = installRig({ homeDir: fakeHome, detectedOnly: true });
    assert.ok(first.linked.length >= 1);
    assert.equal(first.skipped.length, 0);

    const second = updateRig({ homeDir: fakeHome });
    assert.equal(second.linked.length, 0);
    assert.ok(second.skipped.length >= 1);

    // Direct linkSafe verification: already valid symlink is skipped even when force: true
    const targetFile = path.join(testDir, 'target.txt');
    const linkFile = path.join(testDir, 'link.txt');
    writeFileSync(targetFile, 'hello');
    const linked = [];
    const skipped = [];
    assert.equal(linkSafe(targetFile, linkFile, { force: true, linked, skipped }), true);
    assert.equal(linked.length, 1);
    assert.equal(skipped.length, 0);

    const linkedAgain = [];
    const skippedAgain = [];
    assert.equal(linkSafe(targetFile, linkFile, { force: true, linked: linkedAgain, skipped: skippedAgain }), false);
    assert.equal(linkedAgain.length, 0);
    assert.equal(skippedAgain.length, 1);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('installRig and updateRig manage ~/.gemini/antigravity/bin rig wrapper and node/npm symlinks', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-agy-bin-home-'));
  const fakeBinDir = mkdtempSync(path.join(tmpdir(), 'rig-agy-node-bin-'));
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    const fakeNode = path.join(fakeBinDir, 'node');
    const fakeNpm = path.join(fakeBinDir, 'npm');
    writeFileSync(fakeNode, '#!/bin/sh\necho node\n', { mode: 0o755 });
    writeFileSync(fakeNpm, '#!/bin/sh\necho npm\n', { mode: 0o755 });

    const agyBinDir = path.join(fakeHome, '.gemini/antigravity/bin');
    const agyRig = path.join(agyBinDir, 'rig');
    const agyNode = path.join(agyBinDir, 'node');
    const agyNpm = path.join(agyBinDir, 'npm');

    // 1. Initial install with explicit non-system nodeBin creates executable wrapper and symlinks node and npm
    const res1 = installRig({ homeDir: fakeHome, harnesses: ['antigravity'], nodeBin: fakeNode });
    assert.deepEqual(res1.installedHarnesses, ['antigravity']);
    assert.ok(existsSync(agyRig) && !lstatSync(agyRig).isSymbolicLink());
    assert.equal(lstatSync(agyRig).mode & 0o111, 0o111);
    assert.match(readFileSync(agyRig, 'utf8'), /exec /);
    assert.ok(res1.updated.includes(agyRig));

    assert.ok(lstatSync(agyNode).isSymbolicLink());
    assert.equal(readlinkSync(agyNode), fakeNode);
    assert.ok(res1.linked.includes(agyNode));

    assert.ok(lstatSync(agyNpm).isSymbolicLink());
    assert.equal(readlinkSync(agyNpm), fakeNpm);
    assert.ok(res1.linked.includes(agyNpm));

    // 2. Subsequent installRig and updateRig calls remain idempotent
    const res2 = installRig({ homeDir: fakeHome, harnesses: ['antigravity'], nodeBin: fakeNode });
    assert.ok(!res2.linked.includes(agyNode));
    assert.ok(!res2.linked.includes(agyNpm));
    assert.ok(!res2.updated.includes(agyRig));
    assert.ok(res2.skipped.includes(agyRig));
    assert.ok(res2.skipped.includes(agyNode));
    assert.ok(res2.skipped.includes(agyNpm));

    // Plant a dangling rig symlink in antigravity bin
    const dangling = path.join(agyBinDir, 'dangling-rig');
    symlinkSync(path.join(RIG_ROOT, 'bin/does-not-exist'), dangling);
    assert.ok(lstatSync(dangling).isSymbolicLink());

    const res3 = updateRig({ homeDir: fakeHome, nodeBin: fakeNode });
    assert.ok(!res3.linked.includes(agyNode));
    assert.ok(!res3.linked.includes(agyNpm));
    assert.ok(!res3.updated.includes(agyRig));
    assert.ok(res3.skipped.includes(agyRig));
    assert.ok(res3.skipped.includes(agyNode));
    assert.ok(res3.skipped.includes(agyNpm));
    assert.ok(res3.pruned.includes(dangling));
    assert.equal(existsSync(dangling), false);

    // 3. installRig with nodeBin: 'node' does not create node or npm symlinks
    const fakeHomeSystem = mkdtempSync(path.join(tmpdir(), 'rig-agy-sys-home-'));
    try {
      mkdirSync(path.join(fakeHomeSystem, '.gemini'), { recursive: true });
      const resSys = installRig({ homeDir: fakeHomeSystem, harnesses: ['antigravity'], nodeBin: 'node' });
      const sysAgyBin = path.join(fakeHomeSystem, '.gemini/antigravity/bin');
      const sysRig = path.join(sysAgyBin, 'rig');
      const sysNode = path.join(sysAgyBin, 'node');
      const sysNpm = path.join(sysAgyBin, 'npm');

      assert.ok(existsSync(sysRig) && !lstatSync(sysRig).isSymbolicLink());
      assert.equal(lstatSync(sysRig).mode & 0o111, 0o111);
      assert.equal(existsSync(sysNode), false);
      assert.equal(existsSync(sysNpm), false);
      assert.ok(!resSys.linked.includes(sysNode));
      assert.ok(!resSys.linked.includes(sysNpm));
    } finally {
      rmSync(fakeHomeSystem, { recursive: true, force: true });
    }

    // 4. installRig with non-system node without adjacent npm only symlinks node
    const fakeBinSolo = mkdtempSync(path.join(tmpdir(), 'rig-agy-solo-'));
    const fakeHomeSolo = mkdtempSync(path.join(tmpdir(), 'rig-agy-solo-home-'));
    try {
      mkdirSync(path.join(fakeHomeSolo, '.gemini'), { recursive: true });
      const soloNode = path.join(fakeBinSolo, 'node');
      writeFileSync(soloNode, '#!/bin/sh\necho node\n', { mode: 0o755 });
      const resSolo = installRig({ homeDir: fakeHomeSolo, harnesses: ['antigravity'], nodeBin: soloNode });
      const soloBin = path.join(fakeHomeSolo, '.gemini/antigravity/bin');
      assert.ok(lstatSync(path.join(soloBin, 'node')).isSymbolicLink());
      assert.equal(existsSync(path.join(soloBin, 'npm')), false);
      assert.ok(resSolo.linked.includes(path.join(soloBin, 'node')));
      assert.ok(!resSolo.linked.includes(path.join(soloBin, 'npm')));
    } finally {
      rmSync(fakeBinSolo, { recursive: true, force: true });
      rmSync(fakeHomeSolo, { recursive: true, force: true });
    }
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test('installRig cleanly replaces legacy symlinked plugin directory without throwing ERR_FS_EISDIR', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-legacy-symlink-'));
  try {
    const pluginsDir = path.join(fakeHome, '.gemini/config/plugins');
    mkdirSync(pluginsDir, { recursive: true });
    const legacyTargetDir = path.join(fakeHome, 'legacy-target');
    mkdirSync(legacyTargetDir, { recursive: true });
    writeFileSync(path.join(legacyTargetDir, 'dummy.txt'), 'old\n');

    // Plant a symlink pointing to a directory
    const pluginLink = path.join(pluginsDir, 'agent-rig');
    symlinkSync(legacyTargetDir, pluginLink);
    assert.ok(lstatSync(pluginLink).isSymbolicLink());

    const res = installRig({ homeDir: fakeHome, harnesses: ['antigravity'] });
    assert.deepEqual(res.installedHarnesses, ['antigravity']);
    assert.equal(lstatSync(pluginLink).isSymbolicLink(), false);
    assert.ok(existsSync(path.join(pluginLink, 'plugin.json')));
    assert.equal(existsSync(path.join(legacyTargetDir, 'dummy.txt')), true);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('updateRig refreshes repo git hooks without overwriting user-edited AGENTS.md or docs/backlog.md', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-upd-home-'));
  const repo = mkdtempSync(path.join(tmpdir(), 'rig-upd-repo-'));
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    installRig({ homeDir: fakeHome, harnesses: ['antigravity'] });

    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    spawnSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    spawnSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    initRepo(repo, { selfContained: false, worktrees: true, homeDir: fakeHome });

    // User customizes AGENTS.md and docs/backlog.md
    writeFileSync(path.join(repo, 'AGENTS.md'), '# Custom Project Rules\n');
    writeFileSync(path.join(repo, 'docs/backlog.md'), '# Custom Backlog\n');
    // Simulate an outdated pre-commit hook and legacy pre-merge-commit
    mkdirSync(path.join(repo, 'scripts/git-hooks'), { recursive: true });
    writeFileSync(path.join(repo, 'scripts/git-hooks/pre-commit'), '#!/bin/sh\n# old\n');
    writeFileSync(path.join(repo, 'scripts/git-hooks/pre-merge-commit'), '#!/bin/sh\n# legacy\n');

    // 1. Default updateRig only inspects and reports notice without mutating disk
    const defaultUpd = updateRig({ homeDir: fakeHome });
    assert.equal(defaultUpd.updatedRepos.length, 0);
    assert.equal(defaultUpd.pendingRepos.length, 1);
    assert.match(defaultUpd.notice, /Notice: 1 initialized repository\(ies\) have pending agent-rig updates/);
    assert.equal(existsSync(path.join(repo, 'scripts/git-hooks/pre-commit')), true);

    // 2. updateRig with allRepos skips on dirty working tree
    const dirtyUpd = updateRig({ homeDir: fakeHome, allRepos: true });
    assert.equal(dirtyUpd.updatedRepos.length, 0);
    assert.equal(dirtyUpd.skippedRepos.length, 1);
    assert.equal(dirtyUpd.skippedRepos[0].reason, 'dirty');
    assert.match(dirtyUpd.warnings[0], /working tree has uncommitted changes/);
    assert.equal(existsSync(path.join(repo, 'scripts/git-hooks/pre-commit')), true);

    // 3. Clean and commit working tree on main
    spawnSync('git', ['-C', repo, 'add', '-A']);
    spawnSync('git', ['-C', repo, 'commit', '-m', 'chore: initial']);

    // 4. Explicit update with clean working tree updates hooks and cleans legacy files
    const upd = updateRig({ homeDir: fakeHome, allRepos: true });
    assert.equal(upd.updatedRepos.length, 1);
    const updatedAgents = readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
    assert.ok(updatedAgents.includes('# Custom Project Rules'));
    assert.ok(updatedAgents.includes('<!-- AGENT-RIG:START -->'));
    assert.ok(updatedAgents.includes('<!-- AGENT-RIG:END -->'));
    assert.equal(readFileSync(path.join(repo, 'docs/backlog.md'), 'utf8'), '# Custom Backlog\n');
    assert.ok(existsSync(path.join(repo, '.rig/hooks/pre-commit')));
    assert.equal(existsSync(path.join(repo, 'scripts/git-hooks/pre-commit')), false);
    assert.equal(existsSync(path.join(repo, 'scripts/git-hooks/pre-merge-commit')), false);
    assert.equal(existsSync(path.join(repo, 'scripts/git-hooks')), false);
    const hooksPath = spawnSync('git', ['-C', repo, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(hooksPath, '.rig/hooks');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('lightweight initRepo scaffolds a clean project that passes rig check-docs and rig reflow-docs immediately', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rig-init-light-'));
  try {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const res = initRepo(dir, { selfContained: false, worktrees: true, ui: true });
    assert.equal(res.hooksConfigured, true);
    assert.ok(existsSync(path.join(dir, 'AGENTS.md')));
    assert.ok(existsSync(path.join(dir, 'docs/backlog.md')));
    assert.ok(existsSync(path.join(dir, 'docs/adr/0001-record-architecture-decisions.md')));
    assert.ok(existsSync(path.join(dir, 'docs/design/mockup-scaffold.html')));
    assert.equal(existsSync(path.join(dir, 'skills')), false);

    const checkLinks = runCheckDocs(dir);
    assert.equal(checkLinks.status, 0, `${checkLinks.stdout}${checkLinks.stderr}`);

    const checkFormat = runReflowDocs(dir, { check: true });
    assert.equal(checkFormat.status, 0, `${checkFormat.stdout}${checkFormat.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('self-contained initRepo bundles skills, subagents, rules, hooks, and linters into the target repo', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rig-init-self-'));
  try {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });

    // Fail-fast when no harness is detected or specified
    const failDir = mkdtempSync(path.join(tmpdir(), 'rig-fail-fast-'));
    try {
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: failDir });
      assert.throws(
        () => initRepo(failDir, { selfContained: true, worktrees: true, homeDir: false }),
        /No harness detected or specified for --self-contained mode\. Pass --harness <antigravity\|claude\|codex\|cursor> or create a harness dot-directory first\./,
      );
    } finally {
      rmSync(failDir, { recursive: true, force: true });
    }

    initRepo(dir, { selfContained: true, worktrees: true, harness: 'claude', homeDir: false });
    const st = statusRepo(dir);
    assert.equal(st.skillsPresent.length, listSkills(path.join(RIG_ROOT, 'skills')).length);
    assert.ok(st.skillsPresent.includes('rig-onboard'));
    assert.equal(st.hooksPresent.length, 3);
    assert.ok(existsSync(path.join(dir, '.claude/agents/verifier.md')));
    assert.ok(existsSync(path.join(dir, '.claude/agents/worker.md')));
    assert.ok(existsSync(path.join(dir, '.claude/rules/contract-change-gate.md')));
    assert.ok(existsSync(path.join(dir, '.rig/bin/rig.mjs')));
    assert.ok(existsSync(path.join(dir, '.rig/hooks/pre-commit')));

    const checkLinks = runCheckDocs(dir);
    assert.equal(checkLinks.status, 0, `${checkLinks.stdout}${checkLinks.stderr}`);
    const checkFormat = runReflowDocs(dir, { check: true });
    assert.equal(checkFormat.status, 0, `${checkFormat.stdout}${checkFormat.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initRepo on a non-git directory automatically initializes git and registers in state.initializedRepos', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rig-init-nongit-'));
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-nongit-home-'));
  try {
    const res = initRepo(dir, { worktrees: true, homeDir: fakeHome });
    assert.ok(existsSync(path.join(dir, '.git')));
    assert.equal(res.hooksConfigured, true);
    assert.ok(existsSync(path.join(dir, '.rig/hooks/pre-commit')));
    const hooksPath = spawnSync('git', ['-C', dir, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(hooksPath, '.rig/hooks');

    const state = readRigState(fakeHome);
    assert.ok(state.initializedRepos.includes(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('both Antigravity and Claude Code plugin manifests are valid and point to existing files', () => {
  const agyPlugin = JSON.parse(readFileSync(path.join(RIG_ROOT, 'plugin.json'), 'utf8'));
  assert.equal(agyPlugin.name, 'agent-rig');
  const agyHooks = JSON.parse(readFileSync(path.join(RIG_ROOT, 'hooks.json'), 'utf8'));
  assert.ok(agyHooks['remote-mutation-guard']);
  assert.ok(agyHooks['main-checkout-edits-guard']);
  assert.ok(agyHooks['symlinked-node-modules-guard']);

  const claudePlugin = JSON.parse(readFileSync(path.join(RIG_ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(claudePlugin.skills, './skills');
  assert.equal(claudePlugin.agents, './agents');
  assert.equal(claudePlugin.hooks, './hooks/claude-hooks.json');
  assert.ok(existsSync(path.join(RIG_ROOT, claudePlugin.skills, 'dispatch/SKILL.md')));
  assert.ok(existsSync(path.join(RIG_ROOT, claudePlugin.agents, 'verifier.md')));
  assert.ok(existsSync(path.join(RIG_ROOT, claudePlugin.agents, 'worker.md')));
  assert.ok(existsSync(path.join(RIG_ROOT, claudePlugin.hooks)));
});

test('loadCatalog, resolveSubagentModel, resolveProfile, and hydrateText enforce data-driven resolution without hardcoded model names', () => {
  const catalog = loadCatalog(RIG_ROOT);
  assert.ok(catalog.harnesses.antigravity);
  assert.ok(catalog.harnesses.claude);
  assert.ok(catalog.models['gemini-4-argon']);
  assert.ok(catalog.models['claude-opus-5-5']);

  // Builtin model mappings
  assert.equal(resolveSubagentModel('antigravity', 'gemini-4-argon', null, { rigRoot: RIG_ROOT }), 'pro');
  assert.equal(resolveSubagentModel('antigravity', 'gemini-3-8-flash', null, { rigRoot: RIG_ROOT }), 'flash');
  assert.equal(resolveSubagentModel('claude', 'claude-opus-5-5', null, { rigRoot: RIG_ROOT }), 'opus');
  assert.equal(resolveSubagentModel('claude', 'claude-sonnet-5-5', null, { rigRoot: RIG_ROOT }), 'sonnet');
  assert.equal(resolveSubagentModel('claude', 'claude-haiku-5-5', null, { rigRoot: RIG_ROOT }), 'haiku');

  // Explicit selector wins
  assert.equal(resolveSubagentModel('antigravity', 'gemini-4-argon', 'flash_lite', { rigRoot: RIG_ROOT }), 'flash_lite');

  // Custom user-defined model from config
  const customConfig = {
    models: {
      'custom-llama': {
        subagentSelector: {
          antigravity: 'flash',
        },
      },
    },
  };
  assert.equal(resolveSubagentModel('antigravity', 'custom-llama', null, { rigRoot: RIG_ROOT, userConfig: customConfig }), 'flash');

  // Fallback for unknown model to harness defaultSubagentSelector
  assert.equal(resolveSubagentModel('antigravity', 'completely-unknown-model', null, { rigRoot: RIG_ROOT }), 'inherit');

  // Profile resolution
  const profile = resolveProfile('antigravity', { rigRoot: RIG_ROOT });
  assert.equal(profile.harness, 'antigravity');
  assert.equal(profile.profileName, 'antigravity-budget');
  assert.deepEqual(Object.keys(profile.roles).sort(), ['architect', 'utility', 'verifier', 'worker']);
  assert.equal(profile.roles.worker.model, 'gemini-3-8-flash');
  assert.equal(profile.roles.worker.subagentModel, 'flash');

  // Hydration replaces all placeholders
  const sampleTemplate = 'Profile: {{RIG_PROFILE}} for {{RIG_HARNESS}}. Worker: {{SUBAGENT_MODEL_WORKER}} ({{MODEL_WORKER}}, {{EFFORT_WORKER}}). Verifier: {{SUBAGENT_MODEL_VERIFIER}}.';
  const hydrated = hydrateText(sampleTemplate, profile);
  assert.equal(hydrated, 'Profile: antigravity-budget for antigravity. Worker: flash (gemini-3-8-flash, high). Verifier: flash.');

  // Hydration fails on unresolved token
  assert.throws(
    () => hydrateText('Oops {{UNKNOWN_TOKEN}}', profile),
    /Unresolved template placeholder\(s\) in hydrated content: \{\{UNKNOWN_TOKEN\}\}/,
  );
});

test('rig profile and rig model resolve inspect, switch, and set profile roles', () => {
  const fakeRig = mkdtempSync(path.join(tmpdir(), 'rig-test-root-'));
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-test-home-'));
  try {
    // Scaffold fake rig root with templates
    mkdirSync(path.join(fakeRig, 'templates'), { recursive: true });
    mkdirSync(path.join(fakeRig, 'skills/dispatch'), { recursive: true });
    mkdirSync(path.join(fakeRig, 'agents'), { recursive: true });
    mkdirSync(path.join(fakeRig, 'rules'), { recursive: true });
    mkdirSync(path.join(fakeRig, 'hooks'), { recursive: true });
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });

    copyFileSync(path.join(RIG_ROOT, 'templates/models.json'), path.join(fakeRig, 'templates/models.json'));
    copyFileSync(path.join(RIG_ROOT, 'templates/rig-config.default.json'), path.join(fakeRig, 'templates/rig-config.default.json'));
    copyFileSync(path.join(RIG_ROOT, 'templates/rig-config.schema.json'), path.join(fakeRig, 'templates/rig-config.schema.json'));
    copyFileSync(path.join(RIG_ROOT, 'plugin.json'), path.join(fakeRig, 'plugin.json'));
    copyFileSync(path.join(RIG_ROOT, 'hooks.json'), path.join(fakeRig, 'hooks.json'));
    writeFileSync(path.join(fakeRig, 'rules/AGENTS.md'), '# Rules\nProfile: {{RIG_PROFILE}}\nWorker: {{MODEL_WORKER}}\n');
    writeFileSync(path.join(fakeRig, 'agents/worker.md'), '# Worker\nProfile: {{RIG_PROFILE}}\nWorker: {{MODEL_WORKER}}\n');
    writeFileSync(path.join(fakeRig, 'skills/dispatch/SKILL.md'), '# Dispatch\nModel: {{SUBAGENT_MODEL_WORKER}}\n');

    // Install rig globally in fakeHome
    installRig({ homeDir: fakeHome, harnesses: ['antigravity'], rigRoot: fakeRig });

    // Initial inspection
    const initialProfiles = listProfiles(fakeRig);
    assert.equal(initialProfiles.activeProfiles.antigravity, 'antigravity-budget');
    assert.equal(initialProfiles.profiles['antigravity-budget'].isActive, true);

    const resolvedWorker = resolveRoleModel('worker', { harness: 'antigravity', rigRoot: fakeRig });
    assert.equal(resolvedWorker.model, 'gemini-3-8-flash');
    assert.equal(resolvedWorker.subagentModel, 'flash');

    // Switch profile to antigravity-pro
    useProfile('antigravity-pro', { rigRoot: fakeRig, homeDir: fakeHome });
    const afterUse = listProfiles(fakeRig);
    assert.equal(afterUse.activeProfiles.antigravity, 'antigravity-pro');
    assert.equal(existsSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig/rules/AGENTS.md')), false);
    const hydratedWorker = readFileSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig/agents/worker.md'), 'utf8');
    assert.match(hydratedWorker, /Profile: antigravity-pro/);
    assert.match(hydratedWorker, /Worker: gemini-4-argon/);

    // Update role in profile
    setProfileRole('worker', 'claude-opus-5-5', { effort: 'medium', rigRoot: fakeRig, homeDir: fakeHome, harness: 'antigravity' });
    const afterSet = resolveRoleModel('worker', { harness: 'antigravity', rigRoot: fakeRig });
    assert.equal(afterSet.model, 'claude-opus-5-5');
    assert.equal(afterSet.subagentModel, 'pro'); // claude-opus-5-5 mapped to pro on antigravity
    assert.equal(afterSet.effort, 'medium');

    const rehydratedWorker = readFileSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig/agents/worker.md'), 'utf8');
    assert.match(rehydratedWorker, /Worker: claude-opus-5-5/);
  } finally {
    rmSync(fakeRig, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('resolveNodeBinary resolves node in systemPath or falls back to execPath', () => {
  // When systemPath has no node, falls back to execPath
  assert.equal(
    resolveNodeBinary({ execPath: '/mock/node/custom', systemPath: '/nonexistent/bin' }),
    '/mock/node/custom',
  );

  // When node is available in systemPath, returns 'node'
  const sysNodeDir = path.dirname(process.execPath);
  assert.equal(
    resolveNodeBinary({ execPath: '/mock/node/custom', systemPath: sysNodeDir }),
    'node',
  );
});

test('buildHookCommand wraps node execution with fail-safe error message', () => {
  const cmd = buildHookCommand('./hooks/guard-remote-mutation.mjs', '--harness=antigravity', {
    nodeBin: '/fake/node',
  });
  assert.match(cmd, /NODE="\/fake\/node"/);
  assert.match(cmd, /Run 'rig update' in your terminal to re-point hooks\./);
  assert.match(cmd, /exec "\$NODE" "\.\/hooks\/guard-remote-mutation\.mjs" --harness=antigravity/);

  // Executing the built command in shell when node does not exist exits 1 with the error message
  const failRun = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env: { PATH: '/empty', HOME: '/empty' } });
  assert.equal(failRun.status, 1);
  assert.match(failRun.stderr, /agent-rig: Node runtime not found at '\/fake\/node'\. Run 'rig update'/);

  // Executing with a valid node (process.execPath) runs successfully
  const scriptFile = path.join(tmpdir(), `rig-test-hook-${Date.now()}.mjs`);
  writeFileSync(scriptFile, 'process.stdout.write("OK");');
  try {
    const passCmd = buildHookCommand(scriptFile, '', { nodeBin: process.execPath });
    const passRun = spawnSync('/bin/sh', ['-c', passCmd], { encoding: 'utf8' });
    assert.equal(passRun.status, 0);
    assert.equal(passRun.stdout, 'OK');
  } finally {
    rmSync(scriptFile, { force: true });
  }
});

test('hydrateAntigravityHooksJson updates hooks.json commands with wrapped node binary and is idempotent', () => {
  const raw = {
    'remote-mutation-guard': {
      PreToolUse: [
        {
          matcher: 'run_command',
          hooks: [{ type: 'command', command: 'node ./hooks/guard-remote-mutation.mjs --harness=antigravity' }],
        },
      ],
    },
  };

  const hydrated = hydrateAntigravityHooksJson(raw, { nodeBin: '/opt/nvm/node' });
  const hookCmd = hydrated['remote-mutation-guard'].PreToolUse[0].hooks[0].command;
  assert.match(hookCmd, /NODE="\/opt\/nvm\/node"/);
  assert.match(hookCmd, /Run 'rig update'/);
  assert.match(hookCmd, /exec "\$NODE" "\.\/hooks\/guard-remote-mutation\.mjs" --harness=antigravity/);

  // Re-hydrating with a different node path updates the existing wrapped command without nesting
  const rehydrated = hydrateAntigravityHooksJson(hydrated, { nodeBin: '/new/nvm/node' });
  const rehookCmd = rehydrated['remote-mutation-guard'].PreToolUse[0].hooks[0].command;
  assert.match(rehookCmd, /NODE="\/new\/nvm\/node"/);
  assert.equal(rehookCmd.includes('/opt/nvm/node'), false);
  assert.equal(rehookCmd.split('Run \'rig update\'').length, 2);
});

test('mergeClaudeSettings updates existing agent-rig hooks in place when node binary changes', () => {
  const initialClaude = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'node "/home/user/.claude/hooks/guard-remote-mutation.mjs" --harness=claude' },
            { type: 'command', command: 'my-custom-check.sh' },
          ],
        },
      ],
    },
  };

  const incoming = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: buildHookCommand('/home/user/.claude/hooks/guard-remote-mutation.mjs', '--harness=claude', { nodeBin: '/new/node' }) },
          ],
        },
      ],
    },
  };

  const merged = mergeClaudeSettings(initialClaude, incoming);
  const bashHooks = merged.hooks.PreToolUse[0].hooks;
  assert.equal(bashHooks.length, 2);
  assert.equal(bashHooks[1].command, 'my-custom-check.sh');
  assert.match(bashHooks[0].command, /NODE="\/new\/node"/);
});

test('buildRigWrapperScript generates executable shell wrapper with fail-safe error message', () => {
  const wrapper = buildRigWrapperScript(path.join(RIG_ROOT, 'bin/rig.mjs'), { nodeBin: '/mock/nvm/node' });
  assert.match(wrapper, /NODE="\/mock\/nvm\/node"/);
  assert.match(wrapper, /Run 'rig update' in your terminal to re-point\./);
  assert.match(wrapper, /exec "\$NODE"/);

  // Executing the wrapper in shell when node does not exist exits 1 with diagnostic
  const failRun = spawnSync('/bin/sh', ['-c', wrapper, '--', 'status', RIG_ROOT], {
    encoding: 'utf8',
    env: { PATH: '/empty', HOME: '/empty' },
  });
  assert.equal(failRun.status, 1);
  assert.match(failRun.stderr, /agent-rig: Node runtime not found at '\/mock\/nvm\/node'\. Run 'rig update'/);

  // Executing with the real process.execPath executes successfully
  const validWrapper = buildRigWrapperScript(path.join(RIG_ROOT, 'bin/rig.mjs'), { nodeBin: process.execPath });
  const validRun = spawnSync('/bin/sh', ['-c', validWrapper, '--', 'status', RIG_ROOT], { encoding: 'utf8' });
  assert.equal(validRun.status, 0, validRun.stderr);
  assert.equal(JSON.parse(validRun.stdout).hasAgentsMd, true);
});

test('initRepo and updateRepo accept --harness and probe target repo harness', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rig-harness-opt-'));
  try {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });

    // 1. Explicit --harness antigravity on initRepo
    initRepo(dir, { selfContained: true, worktrees: true, harness: 'antigravity' });
    const workerContent = readFileSync(path.join(dir, '.gemini/agents/worker.md'), 'utf8');
    assert.match(workerContent, /model: flash/);
    assert.match(workerContent, /gemini-3-8-flash/);
    assert.equal(workerContent.includes('claude-sonnet-5-5'), false);

    const verifierContent = readFileSync(path.join(dir, '.gemini/agents/verifier.md'), 'utf8');
    assert.match(verifierContent, /model: flash/);
    assert.match(verifierContent, /gemini-3-8-flash/);

    const dispatchContent = readFileSync(path.join(dir, '.gemini/skills/dispatch/SKILL.md'), 'utf8');
    assert.match(dispatchContent, /subagent model `flash`, target `gemini-3-8-flash`/);

    // Links inside self-contained repo retain relative repo structure and pass check-doc-links
    const checkLinks = runCheckDocs(dir);
    assert.equal(checkLinks.status, 0, `${checkLinks.stdout}${checkLinks.stderr}`);

    // 2. updateRepo with explicit harness overrides
    updateRepo(dir, { harness: 'claude' });
    const updatedWorker = readFileSync(path.join(dir, '.claude/agents/worker.md'), 'utf8');
    assert.match(updatedWorker, /model: sonnet/);
    assert.match(updatedWorker, /claude-sonnet-5-5/);

    // 3. Probing target repo with .gemini directory
    mkdirSync(path.join(dir, '.gemini'), { recursive: true });
    assert.equal(detectRepoHarness(dir), 'antigravity');

    updateRepo(dir); // probes .gemini -> antigravity
    const probedWorker = readFileSync(path.join(dir, '.gemini/agents/worker.md'), 'utf8');
    assert.match(probedWorker, /model: flash/);
    assert.match(probedWorker, /gemini-3-8-flash/);

    // 4. CLI end-to-end init with --harness option
    const cliDir = mkdtempSync(path.join(tmpdir(), 'rig-cli-harness-'));
    const fakeCliHome = mkdtempSync(path.join(tmpdir(), 'rig-cli-home-'));
    try {
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: cliDir });
      const cliRes = spawnSync(process.execPath, [
        path.join(RIG_ROOT, 'bin/rig.mjs'),
        'init',
        cliDir,
        '--self-contained',
        '--harness',
        'antigravity',
      ], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fakeCliHome },
      });
      assert.equal(cliRes.status, 0, cliRes.stderr);
      const cliWorker = readFileSync(path.join(cliDir, '.gemini/agents/worker.md'), 'utf8');
      assert.match(cliWorker, /model: flash/);
      assert.match(cliWorker, /gemini-3-8-flash/);
    } finally {
      rmSync(cliDir, { recursive: true, force: true });
      rmSync(fakeCliHome, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installRig rewrites relative inter-doc links for Codex and hydrates repo-relative docs links in global skills', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-links-home-'));
  try {
    const res = installRig({ homeDir: fakeHome, harnesses: ['codex', 'claude'] });
    assert.deepEqual(res.installedHarnesses, ['codex', 'claude']);

    // Global install does NOT write global AGENTS.md for Codex or Claude (rules live in per-repo demarcated blocks)
    assert.equal(existsSync(path.join(fakeHome, '.codex/AGENTS.md')), false);
    assert.equal(existsSync(path.join(fakeHome, '.claude/rules/AGENTS.md')), false);

    // Codex skills must point to repo-relative docs/backlog.md rather than ../../docs/backlog.md
    const codexBacklogSkill = readFileSync(path.join(fakeHome, '.codex/skills/backlog-audit/SKILL.md'), 'utf8');
    assert.match(codexBacklogSkill, /\[`docs\/backlog\.md`\]\(docs\/backlog\.md\)/);
    assert.equal(codexBacklogSkill.includes('../../docs/backlog.md'), false);

    // Global Claude skills also rewrite ../../docs/ to repo-relative docs/
    const claudeBacklogSkill = readFileSync(path.join(fakeHome, '.claude/skills/backlog-audit/SKILL.md'), 'utf8');
    assert.match(claudeBacklogSkill, /\[`docs\/backlog\.md`\]\(docs\/backlog\.md\)/);
    assert.equal(claudeBacklogSkill.includes('../../docs/backlog.md'), false);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('detectExistingHookManager and getHookChainingGuidance detect hook runners and provide chaining templates', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rig-hookmgr-'));
  try {
    // Clean directory has no hook manager
    assert.equal(detectExistingHookManager(root), null);

    // Husky detection
    const huskyDir = path.join(root, '.husky');
    mkdirSync(huskyDir);
    const huskyMgr = detectExistingHookManager(root);
    assert.deepEqual(huskyMgr, { type: 'husky', name: 'Husky', path: '.husky' });
    const huskyGuide = getHookChainingGuidance(huskyMgr);
    assert.match(huskyGuide, /\.husky\/pre-commit/);
    assert.match(huskyGuide, /\.\/\.rig\/hooks\/pre-commit "\$@"/);
    rmSync(huskyDir, { recursive: true, force: true });

    // Lefthook detection
    const lefthookFile = path.join(root, 'lefthook.yml');
    writeFileSync(lefthookFile, 'pre-commit:\n  commands:\n');
    const lfMgr = detectExistingHookManager(root);
    assert.deepEqual(lfMgr, { type: 'lefthook', name: 'Lefthook', path: 'lefthook.yml' });
    const lfGuide = getHookChainingGuidance(lfMgr);
    assert.match(lfGuide, /lefthook\.yml/);
    assert.match(lfGuide, /run: \.\/\.rig\/hooks\/pre-commit/);
    rmSync(lefthookFile, { force: true });

    // Python pre-commit detection
    const preCommitFile = path.join(root, '.pre-commit-config.yaml');
    writeFileSync(preCommitFile, 'repos: []\n');
    const pcMgr = detectExistingHookManager(root);
    assert.deepEqual(pcMgr, { type: 'pre-commit', name: 'pre-commit', path: '.pre-commit-config.yaml' });
    const pcGuide = getHookChainingGuidance(pcMgr);
    assert.match(pcGuide, /\.pre-commit-config\.yaml/);
    assert.match(pcGuide, /entry: \.\/\.rig\/hooks\/pre-commit/);
    rmSync(preCommitFile, { force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('initRepo preserves pre-existing hook runners and avoids destroying git hook configuration unless forced', () => {
  // Test with .husky
  const { root: huskyRoot, git: gitHusky, cleanup: cleanupHusky } = makeRepoWithHistory('rig-init-husky-');
  try {
    mkdirSync(path.join(huskyRoot, '.husky'));
    const res = initRepo(huskyRoot, { worktrees: true });
    assert.equal(res.hooksConfigured, false);
    assert.equal(res.existingHookManager?.name, 'Husky');
    assert.match(res.hookWarning, /Existing git hook manager detected \(Husky/);
    assert.match(res.chainingGuidance, /\.husky\/pre-commit/);
    // core.hooksPath should NOT be set
    const hooksPathRes = gitHusky(huskyRoot, 'config', '--get', 'core.hooksPath');
    assert.notEqual(hooksPathRes.stdout.trim(), '.rig/hooks');
    // Pre-commit script is still scaffolded so the user can chain it
    assert.ok(existsSync(path.join(res.dir, '.rig/hooks/pre-commit')));

    // Re-running with force: true overrides
    const forceRes = initRepo(huskyRoot, { worktrees: true, force: true });
    assert.equal(forceRes.hooksConfigured, true);
    assert.equal(gitHusky(huskyRoot, 'config', '--get', 'core.hooksPath').stdout.trim(), '.rig/hooks');
  } finally {
    cleanupHusky();
  }

  // Test with lefthook.yml
  const { root: lfRoot, git: gitLf, cleanup: cleanupLf } = makeRepoWithHistory('rig-init-lf-');
  try {
    writeFileSync(path.join(lfRoot, 'lefthook.yml'), 'pre-commit:\n');
    const res = initRepo(lfRoot, { worktrees: true });
    assert.equal(res.hooksConfigured, false);
    assert.equal(res.existingHookManager?.name, 'Lefthook');
    assert.match(res.hookWarning, /Lefthook/);
    assert.match(res.chainingGuidance, /lefthook\.yml/);
    assert.notEqual(gitLf(lfRoot, 'config', '--get', 'core.hooksPath').stdout.trim(), '.rig/hooks');
  } finally {
    cleanupLf();
  }

  // Test with .pre-commit-config.yaml
  const { root: pcRoot, git: gitPc, cleanup: cleanupPc } = makeRepoWithHistory('rig-init-pc-');
  try {
    writeFileSync(path.join(pcRoot, '.pre-commit-config.yaml'), 'repos: []\n');
    const res = initRepo(pcRoot, { worktrees: true });
    assert.equal(res.hooksConfigured, false);
    assert.equal(res.existingHookManager?.name, 'pre-commit');
    assert.match(res.hookWarning, /pre-commit/);
    assert.match(res.chainingGuidance, /\.pre-commit-config\.yaml/);
    assert.notEqual(gitPc(pcRoot, 'config', '--get', 'core.hooksPath').stdout.trim(), '.rig/hooks');
  } finally {
    cleanupPc();
  }

  // Test with custom core.hooksPath already configured
  const { root: customRoot, git: gitCustom, cleanup: cleanupCustom } = makeRepoWithHistory('rig-init-custom-');
  try {
    gitCustom(customRoot, 'config', 'core.hooksPath', '.custom-hooks');
    const res = initRepo(customRoot, { worktrees: true });
    assert.equal(res.hooksConfigured, false);
    assert.equal(res.existingHookManager?.type, 'custom');
    assert.equal(gitCustom(customRoot, 'config', '--get', 'core.hooksPath').stdout.trim(), '.custom-hooks');
  } finally {
    cleanupCustom();
  }

  // Test that core.hooksPath set to .rig/hooks or scripts/git-hooks is recognized as agent-rig (not custom)
  const { root: rigHooksRoot, git: gitRigHooks, cleanup: cleanupRigHooks } = makeRepoWithHistory('rig-init-righooks-');
  try {
    gitRigHooks(rigHooksRoot, 'config', 'core.hooksPath', '.rig/hooks');
    assert.equal(detectExistingHookManager(rigHooksRoot), null);
    gitRigHooks(rigHooksRoot, 'config', 'core.hooksPath', 'scripts/git-hooks');
    assert.equal(detectExistingHookManager(rigHooksRoot), null);
  } finally {
    cleanupRigHooks();
  }
});

test('buildRigWrapperScript and buildHookCommand fall back to PATH node or version manager shims when baked node is missing', () => {
  const tmpHome = mkdtempSync(path.join(tmpdir(), 'rig-home-shim-'));
  try {
    // 1. Fallback to PATH node when baked node is missing
    const wrapper = buildRigWrapperScript(path.join(RIG_ROOT, 'bin/rig.mjs'), {
      nodeBin: '/uninstalled/nvm/v99.0.0/bin/node',
    });
    // Running with PATH containing the active Node binary falls back and executes successfully
    const pathFallbackRun = spawnSync('/bin/sh', ['-c', wrapper, '--', 'status', RIG_ROOT], {
      encoding: 'utf8',
      env: { ...process.env, PATH: path.dirname(process.execPath), HOME: '/empty' },
    });
    assert.equal(pathFallbackRun.status, 0, pathFallbackRun.stderr);
    assert.equal(JSON.parse(pathFallbackRun.stdout).hasAgentsMd, true);

    // 2. Fallback to NVM structure in HOME when PATH does not have node
    const nvmBinDir = path.join(tmpHome, '.nvm/versions/node/v99.0.0/bin');
    mkdirSync(nvmBinDir, { recursive: true });
    const mockNvmNode = path.join(nvmBinDir, 'node');
    writeFileSync(mockNvmNode, '#!/bin/sh\necho "NVM_SHIM_OK"\n', { mode: 0o755 });

    const nvmFallbackRun = spawnSync('/bin/sh', ['-c', wrapper, '--', 'arg1'], {
      encoding: 'utf8',
      env: { PATH: '/empty', HOME: tmpHome },
    });
    assert.equal(nvmFallbackRun.status, 0, nvmFallbackRun.stderr);
    assert.equal(nvmFallbackRun.stdout.trim(), 'NVM_SHIM_OK');

    // 3. Fallback to fnm structure in HOME
    const emptyFnmHome = mkdtempSync(path.join(tmpdir(), 'rig-home-fnm-'));
    const fnmHomeCurrent = path.join(emptyFnmHome, '.local/share/fnm/current/bin');
    mkdirSync(fnmHomeCurrent, { recursive: true });
    writeFileSync(path.join(fnmHomeCurrent, 'node'), '#!/bin/sh\necho "FNM_SHIM_OK"\n', { mode: 0o755 });

    const fnmFallbackRun = spawnSync('/bin/sh', ['-c', wrapper, '--', 'arg1'], {
      encoding: 'utf8',
      env: { PATH: '/empty', HOME: emptyFnmHome },
    });
    assert.equal(fnmFallbackRun.status, 0, fnmFallbackRun.stderr);
    assert.equal(fnmFallbackRun.stdout.trim(), 'FNM_SHIM_OK');
    rmSync(emptyFnmHome, { recursive: true, force: true });

    // 4. Fallback in buildHookCommand
    const hookScript = path.join(tmpdir(), `rig-test-hook-fallback-${Date.now()}.mjs`);
    writeFileSync(hookScript, 'process.stdout.write("HOOK_FALLBACK_OK");');
    try {
      const hookCmd = buildHookCommand(hookScript, '', { nodeBin: '/dead/node' });
      const hookRun = spawnSync('/bin/sh', ['-c', hookCmd], {
        encoding: 'utf8',
        env: { PATH: path.dirname(process.execPath), HOME: '/empty' },
      });
      assert.equal(hookRun.status, 0, hookRun.stderr);
      assert.equal(hookRun.stdout, 'HOOK_FALLBACK_OK');
    } finally {
      rmSync(hookScript, { force: true });
    }
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('attachRepo configures hooks, re-attaches main, ensures pre-commit hook, and registers in state without worktrees', () => {
  const { root, git, cleanup } = makeRepoWithHistory('rig-attach-');
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-fake-home-'));
  try {
    // Detach HEAD on main checkout
    git(root, 'checkout', '--detach', 'HEAD');
    assert.equal(git(root, 'symbolic-ref', '--short', '-q', 'HEAD').stdout.trim(), '');

    // Add AGENTS.md so repo has rig marker
    writeFileSync(path.join(root, 'AGENTS.md'), '# test project\n');

    const res = attachRepo(root, { homeDir: fakeHome });
    assert.equal(res.dir, root);
    assert.equal(res.hooksConfigured, true);
    assert.equal(res.mainCheckoutHead.status, 'attached');
    assert.equal(res.mainCheckoutHead.branch, 'main');
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), 'main');
    assert.equal(git(root, 'config', '--get', 'core.hooksPath').stdout.trim(), '.rig/hooks');

    // pre-commit hook copied and made executable
    const hookPath = path.join(root, '.rig/hooks/pre-commit');
    assert.ok(existsSync(hookPath));

    // Registered in fakeHome state
    assert.ok(readRigState(fakeHome).initializedRepos.includes(root));

    // No worktree spawned
    assert.equal(existsSync(path.join(root, '.worktrees', 'rig-init')), false);

    // Calling attachRepo when targeting a linked worktree resolves main checkout
    const wt = path.join(root, '.worktrees', 'feat-x');
    git(root, 'worktree', 'add', '-q', '-b', 'feature/feat-x', wt, 'main');
    const resWt = attachRepo(wt, { homeDir: fakeHome });
    assert.equal(resWt.dir, root);
    assert.equal(resWt.hooksConfigured, true);
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('attachRepo preserves existing hook managers unless forced', () => {
  const { root, git, cleanup } = makeRepoWithHistory('rig-attach-husky-');
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-fake-home-'));
  try {
    mkdirSync(path.join(root, '.husky'));
    const res = attachRepo(root, { homeDir: fakeHome });
    assert.equal(res.hooksConfigured, false);
    assert.equal(res.existingHookManager?.name, 'Husky');
    assert.ok(res.hookWarning);
    assert.notEqual(git(root, 'config', '--get', 'core.hooksPath').stdout.trim(), '.rig/hooks');

    // Force override
    const forceRes = attachRepo(root, { homeDir: fakeHome, force: true });
    assert.equal(forceRes.hooksConfigured, true);
    assert.equal(git(root, 'config', '--get', 'core.hooksPath').stdout.trim(), '.rig/hooks');
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('initRepo on already-rigged repository delegates to attachRepo without spawning worktree', () => {
  const { root, git, cleanup } = makeRepoWithHistory('rig-init-delegate-');
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-fake-home-'));
  try {
    writeFileSync(path.join(root, 'AGENTS.md'), '# Existing project\n');
    git(root, 'add', 'AGENTS.md');
    git(root, 'commit', '-qm', 'add AGENTS.md');

    // Detach HEAD to ensure attachRepo re-attaches it
    git(root, 'checkout', '--detach', 'HEAD');

    const res = initRepo(root, { worktrees: true, homeDir: fakeHome });
    assert.equal(res.delegatedToAttach, true);
    assert.equal(res.initWorktree, null);
    assert.equal(res.dir, root);
    assert.equal(res.copied.length, 0);
    assert.equal(res.skipped.length, 0);
    assert.equal(res.merged.length, 0);
    assert.equal(res.staged.length, 0);
    assert.equal(res.hooksConfigured, true);
    assert.equal(res.mainCheckoutHead.status, 'attached');
    assert.equal(res.mainCheckoutHead.branch, 'main');
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), 'main');
    assert.ok(readRigState(fakeHome).initializedRepos.includes(root));
    assert.equal(existsSync(path.join(root, '.worktrees', 'rig-init')), false);

    // End-to-end CLI execution: rig attach <root> --home <fakeHome>
    const cliRes = spawnSync(process.execPath, [path.join(RIG_ROOT, 'bin/rig.mjs'), 'attach', root, '--home', fakeHome], {
      encoding: 'utf8',
    });
    assert.equal(cliRes.status, 0, cliRes.stderr);
    assert.match(cliRes.stdout, /rig attach/);
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('ejectRepo unsets core.hooksPath, deletes .rig/, prunes state, preserves AGENTS.md and docs, and leaves repo un-rigged', () => {
  const { root, git, cleanup } = makeRepoWithHistory('rig-eject-');
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-fake-home-'));
  try {
    // 1. Rig the repo via attachRepo
    writeFileSync(path.join(root, 'AGENTS.md'), '# test project\n');
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs/backlog.md'), '# Backlog\n');
    const attachRes = attachRepo(root, { homeDir: fakeHome });
    assert.equal(attachRes.hooksConfigured, true);
    assert.equal(isRiggedRepo(root), true);
    assert.equal(existsSync(path.join(root, '.rig/hooks/pre-commit')), true);
    assert.ok(readRigState(fakeHome).initializedRepos.includes(root));

    // 2. Call ejectRepo on main checkout
    const ejectRes = ejectRepo(root, { homeDir: fakeHome });
    assert.equal(ejectRes.dir, root);
    assert.equal(ejectRes.hooksUnset, true);
    assert.ok(ejectRes.removedPaths.includes(path.join(root, '.rig')));
    assert.equal(ejectRes.stateRemoved, true);

    // Verify git config core.hooksPath is unset
    const hooksCfg = git(root, 'config', '--get', 'core.hooksPath');
    assert.equal(hooksCfg.stdout.trim(), '');

    // Verify .rig/ is removed
    assert.equal(existsSync(path.join(root, '.rig')), false);

    // Verify removed from state.initializedRepos
    assert.equal(readRigState(fakeHome).initializedRepos.includes(root), false);

    // Verify durable documentation is preserved
    assert.equal(existsSync(path.join(root, 'AGENTS.md')), true);
    assert.equal(existsSync(path.join(root, 'docs/backlog.md')), true);

    // Verify repo is un-rigged
    assert.equal(isRiggedRepo(root), false);

    // 3. Calling ejectRepo again is idempotent
    const secondRes = ejectRepo(root, { homeDir: fakeHome });
    assert.equal(secondRes.dir, root);
    assert.equal(secondRes.hooksUnset, false);
    assert.equal(secondRes.removedPaths.length, 0);
    assert.equal(secondRes.stateRemoved, false);
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('ejectRepo and CLI rig eject work from linked worktree and clean legacy scripts/git-hooks', () => {
  const { root, git, cleanup } = makeRepoWithHistory('rig-eject-wt-');
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-fake-home-'));
  try {
    // Set up legacy scripts/git-hooks and register in state
    const legacyHooks = path.join(root, 'scripts/git-hooks');
    mkdirSync(legacyHooks, { recursive: true });
    writeFileSync(path.join(legacyHooks, 'pre-commit'), '#!/bin/sh\nexit 0\n');
    git(root, 'config', 'core.hooksPath', 'scripts/git-hooks');
    writeRigState(fakeHome, { initializedRepos: [root] });

    assert.equal(isRiggedRepo(root), true);

    // Add a linked worktree
    const wt = path.join(root, '.worktrees', 'feat-eject');
    git(root, 'worktree', 'add', '-q', '-b', 'feature/feat-eject', wt, 'main');

    // Eject from inside the worktree
    const res = ejectRepo(wt, { homeDir: fakeHome });
    assert.equal(res.dir, root);
    assert.equal(res.hooksUnset, true);
    assert.ok(res.removedPaths.includes(legacyHooks));
    assert.equal(res.stateRemoved, true);
    assert.equal(existsSync(legacyHooks), false);
    assert.equal(isRiggedRepo(root), false);
    assert.equal(isRiggedRepo(wt), false);
    assert.equal(readRigState(fakeHome).initializedRepos.includes(root), false);

    // Re-rig and test CLI end-to-end: rig eject <root> --home <fakeHome>
    attachRepo(root, { homeDir: fakeHome });
    assert.equal(isRiggedRepo(root), true);
    assert.ok(readRigState(fakeHome).initializedRepos.includes(root));

    const cliRes = spawnSync(process.execPath, [path.join(RIG_ROOT, 'bin/rig.mjs'), 'eject', root, '--home', fakeHome], {
      encoding: 'utf8',
    });
    assert.equal(cliRes.status, 0, cliRes.stderr);
    assert.match(cliRes.stdout, /rig eject/);
    assert.equal(isRiggedRepo(root), false);
    assert.equal(readRigState(fakeHome).initializedRepos.includes(root), false);
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('validateRepoCleanForUpdate and isSelfContainedRepo validate safety invariants', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rig-clean-test-'));
  try {
    // 1. isSelfContainedRepo detection
    assert.equal(isSelfContainedRepo(dir), false);
    mkdirSync(path.join(dir, '.rig/hooks'), { recursive: true });
    writeFileSync(path.join(dir, '.rig/hooks/pre-commit'), '#!/bin/sh\n');
    // Lightweight repo has .rig/hooks/pre-commit but is NOT self-contained
    assert.equal(isSelfContainedRepo(dir), false);
    mkdirSync(path.join(dir, '.rig/bin'), { recursive: true });
    writeFileSync(path.join(dir, '.rig/bin/rig.mjs'), '#!/usr/bin/env node\n');
    assert.equal(isSelfContainedRepo(dir), true);

    // 2. validateRepoCleanForUpdate on non-git dir
    const nonGit = mkdtempSync(path.join(tmpdir(), 'rig-nongit-'));
    try {
      const res = validateRepoCleanForUpdate(nonGit);
      assert.equal(res.ok, true);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }

    // 3. validateRepoCleanForUpdate on clean repo on main
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', ['-C', dir, 'commit', '-m', 'chore: initial']);

    const cleanMain = validateRepoCleanForUpdate(dir);
    assert.equal(cleanMain.ok, true);
    assert.equal(cleanMain.branch, 'main');

    // 4. Dirty working tree
    writeFileSync(path.join(dir, 'uncommitted.txt'), 'dirty\n');
    const dirtyRes = validateRepoCleanForUpdate(dir);
    assert.equal(dirtyRes.ok, false);
    assert.equal(dirtyRes.reason, 'dirty');
    assert.match(dirtyRes.message, /working tree has uncommitted changes/);

    // Commit file so it's clean again
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', ['-C', dir, 'commit', '-m', 'chore: add uncommitted']);

    // 5. Non-main branch
    spawnSync('git', ['-C', dir, 'checkout', '-b', 'feature/test']);
    const branchRes = validateRepoCleanForUpdate(dir);
    assert.equal(branchRes.ok, false);
    assert.equal(branchRes.reason, 'non-main-branch');
    assert.equal(branchRes.branch, 'feature/test');
    assert.match(branchRes.message, /active branch is 'feature\/test'/);

    // 6. Detached HEAD
    spawnSync('git', ['-C', dir, 'checkout', '--detach', 'HEAD']);
    const detachedRes = validateRepoCleanForUpdate(dir);
    assert.equal(detachedRes.ok, false);
    assert.equal(detachedRes.reason, 'non-main-branch');
    assert.equal(detachedRes.branch, 'HEAD');
    assert.match(detachedRes.message, /active branch is 'detached HEAD'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkRepoPendingUpdates detects pending updates across lightweight and self-contained repos', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-chk-home-'));
  const lightRepo = mkdtempSync(path.join(tmpdir(), 'rig-chk-light-'));
  const selfRepo = mkdtempSync(path.join(tmpdir(), 'rig-chk-self-'));
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    installRig({ homeDir: fakeHome, harnesses: ['antigravity'] });

    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: lightRepo });
    initRepo(lightRepo, { selfContained: false, worktrees: true, homeDir: fakeHome });

    // Up-to-date lightweight repo has no pending updates
    const lightCheck = checkRepoPendingUpdates(lightRepo);
    assert.equal(lightCheck.hasPendingUpdates, false);
    assert.equal(lightCheck.pendingFiles.length, 0);

    // Modify .rig/hooks/pre-commit in lightweight repo -> detected as pending
    writeFileSync(path.join(lightRepo, '.rig/hooks/pre-commit'), '#!/bin/sh\n# outdated hook\n');
    const lightPending = checkRepoPendingUpdates(lightRepo);
    assert.equal(lightPending.hasPendingUpdates, true);
    assert.ok(lightPending.pendingFiles.some((f) => f.endsWith('.rig/hooks/pre-commit')));

    // Setup self-contained repo
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: selfRepo });
    initRepo(selfRepo, { selfContained: true, worktrees: true, homeDir: fakeHome, harness: 'antigravity' });

    // Fresh self-contained repo has no pending updates
    const selfCheck = checkRepoPendingUpdates(selfRepo);
    assert.equal(selfCheck.hasPendingUpdates, false);

    // Tamper with vendored .rig/bin/rig.mjs
    writeFileSync(path.join(selfRepo, '.rig/bin/rig.mjs'), '#!/usr/bin/env node\n// outdated\n');
    const selfPending = checkRepoPendingUpdates(selfRepo);
    assert.equal(selfPending.hasPendingUpdates, true);
    assert.ok(selfPending.pendingFiles.some((f) => f.endsWith('.rig/bin/rig.mjs')));
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(lightRepo, { recursive: true, force: true });
    rmSync(selfRepo, { recursive: true, force: true });
  }
});

test('updateRig selective execution: allRepos and repoDir update clean repos and skip non-main/dirty repos with warnings', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-sel-home-'));
  const cleanRepo = mkdtempSync(path.join(tmpdir(), 'rig-sel-clean-'));
  const branchRepo = mkdtempSync(path.join(tmpdir(), 'rig-sel-branch-'));
  const dirtyRepo = mkdtempSync(path.join(tmpdir(), 'rig-sel-dirty-'));
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    installRig({ homeDir: fakeHome, harnesses: ['antigravity'] });

    // Initialize all 3 repos
    for (const r of [cleanRepo, branchRepo, dirtyRepo]) {
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: r });
      spawnSync('git', ['-C', r, 'config', 'user.email', 'test@example.com']);
      spawnSync('git', ['-C', r, 'config', 'user.name', 'Test']);
      initRepo(r, { selfContained: false, worktrees: true, homeDir: fakeHome });
      spawnSync('git', ['-C', r, 'add', '-A']);
      spawnSync('git', ['-C', r, 'commit', '-m', 'chore: initial']);
    }

    // Put branchRepo on a feature branch
    spawnSync('git', ['-C', branchRepo, 'checkout', '-b', 'feature/test']);

    // Make dirtyRepo dirty
    writeFileSync(path.join(dirtyRepo, 'dirty.txt'), 'dirty content\n');

    // Introduce an outdated hook in cleanRepo to trigger pending
    writeFileSync(path.join(cleanRepo, '.rig/hooks/pre-commit'), '#!/bin/sh\n# outdated\n');
    spawnSync('git', ['-C', cleanRepo, 'add', '-A']);
    spawnSync('git', ['-C', cleanRepo, 'commit', '-m', 'chore: outdated hook']);

    // 1. Default updateRig: inspects all 3, mutates none, returns notice
    const defRes = updateRig({ homeDir: fakeHome });
    assert.equal(defRes.updatedRepos.length, 0);
    assert.equal(defRes.skippedRepos.length, 0);
    assert.equal(defRes.pendingRepos.length, 1);
    assert.equal(defRes.pendingRepos[0].dir, cleanRepo);
    assert.match(defRes.notice, /have pending agent-rig updates/);
    assert.match(readFileSync(path.join(cleanRepo, '.rig/hooks/pre-commit'), 'utf8'), /# outdated/);

    // 2. updateRig with repoDir targeting dirtyRepo -> skipped with warning
    const targetDirtyRes = updateRig({ homeDir: fakeHome, repoDir: dirtyRepo });
    assert.equal(targetDirtyRes.updatedRepos.length, 0);
    assert.equal(targetDirtyRes.skippedRepos.length, 1);
    assert.equal(targetDirtyRes.skippedRepos[0].reason, 'dirty');
    assert.equal(targetDirtyRes.warnings.length, 1);
    assert.match(targetDirtyRes.warnings[0], /working tree has uncommitted changes/);

    // 3. updateRig with repoDir targeting branchRepo -> skipped with warning
    const targetBranchRes = updateRig({ homeDir: fakeHome, repoDir: branchRepo });
    assert.equal(targetBranchRes.updatedRepos.length, 0);
    assert.equal(targetBranchRes.skippedRepos.length, 1);
    assert.equal(targetBranchRes.skippedRepos[0].reason, 'non-main-branch');
    assert.equal(targetBranchRes.warnings.length, 1);
    assert.match(targetBranchRes.warnings[0], /active branch is 'feature\/test'/);

    // 4. updateRig with repoDir targeting cleanRepo -> updated and auto-committed
    const targetCleanRes = updateRig({ homeDir: fakeHome, repoDir: cleanRepo });
    assert.equal(targetCleanRes.updatedRepos.length, 1);
    assert.equal(targetCleanRes.skippedRepos.length, 0);
    assert.equal(targetCleanRes.warnings.length, 0);
    assert.doesNotMatch(readFileSync(path.join(cleanRepo, '.rig/hooks/pre-commit'), 'utf8'), /# outdated/);
    assert.equal(targetCleanRes.updatedRepos[0].committed, true);
    assert.ok(targetCleanRes.updatedRepos[0].commitSha);
    const cleanStatus = spawnSync('git', ['-C', cleanRepo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(cleanStatus, '');
    const lastCommitMsg = spawnSync('git', ['-C', cleanRepo, 'log', '-1', '--pretty=%B'], { encoding: 'utf8' }).stdout.trim();
    assert.match(lastCommitMsg, /chore\(rig\): update agent-rig repository assets/);
    assert.match(lastCommitMsg, /Unmandated-call: none/);

    // Calling updateRig again when repo has no changes does not create an empty commit
    const noopRes = updateRig({ homeDir: fakeHome, repoDir: cleanRepo });
    assert.equal(noopRes.updatedRepos.length, 1);
    assert.equal(noopRes.updatedRepos[0].committed, false);
    const noopCommitMsg = spawnSync('git', ['-C', cleanRepo, 'log', '-1', '--pretty=%B'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(noopCommitMsg, lastCommitMsg);

    // 5. updateRig with allRepos: true -> cleanRepo updated and auto-committed, branchRepo and dirtyRepo skipped
    // Outdate cleanRepo again to re-test allRepos
    writeFileSync(path.join(cleanRepo, '.rig/hooks/pre-commit'), '#!/bin/sh\n# outdated again\n');
    spawnSync('git', ['-C', cleanRepo, 'add', '-A']);
    spawnSync('git', ['-C', cleanRepo, 'commit', '-m', 'chore: outdated hook again']);

    const allRes = updateRig({ homeDir: fakeHome, allRepos: true });
    assert.equal(allRes.updatedRepos.length, 1);
    assert.equal(allRes.updatedRepos[0].dir, cleanRepo);
    assert.equal(allRes.updatedRepos[0].committed, true);
    assert.ok(allRes.updatedRepos[0].commitSha);
    const allCleanStatus = spawnSync('git', ['-C', cleanRepo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(allCleanStatus, '');
    assert.equal(allRes.skippedRepos.length, 2);
    assert.ok(allRes.skippedRepos.some((s) => s.dir === branchRepo && s.reason === 'non-main-branch'));
    assert.ok(allRes.skippedRepos.some((s) => s.dir === dirtyRepo && s.reason === 'dirty'));
    assert.equal(allRes.warnings.length, 2);
    assert.doesNotMatch(readFileSync(path.join(cleanRepo, '.rig/hooks/pre-commit'), 'utf8'), /# outdated/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(cleanRepo, { recursive: true, force: true });
    rmSync(branchRepo, { recursive: true, force: true });
    rmSync(dirtyRepo, { recursive: true, force: true });
  }
});

test('templates/ci/rig-verify.yml exists and defines GitHub Actions PR/push verification steps', () => {
  const templatePath = path.join(RIG_ROOT, 'templates/ci/rig-verify.yml');
  assert.ok(existsSync(templatePath), 'templates/ci/rig-verify.yml must exist');
  const content = readFileSync(templatePath, 'utf8');
  assert.match(content, /name:\s*rig-verify/);
  assert.match(content, /pull_request:/);
  assert.match(content, /npm test/);
  assert.match(content, /check-doc-links/);
  assert.match(content, /reflow-docs --check/);
});

test('multi-environment self-contained repository lifecycle across all 4 harnesses: layout, update, attach, and eject', () => {
  const HARNESSES = [
    { id: 'antigravity', dotDir: '.gemini' },
    { id: 'claude', dotDir: '.claude' },
    { id: 'codex', dotDir: '.codex' },
    { id: 'cursor', dotDir: '.cursor' },
  ];

  for (const h of HARNESSES) {
    const repo = mkdtempSync(path.join(tmpdir(), `rig-self-${h.id}-`));
    const fakeHome = mkdtempSync(path.join(tmpdir(), `rig-home-${h.id}-`));
    try {
      installRig({ homeDir: fakeHome, harnesses: [h.id] });
      const git = (cwd, ...args) =>
        spawnSync('git', args, {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, HOME: fakeHome, PATH: `${path.join(fakeHome, '.local/bin')}:${process.env.PATH}` },
        });
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Test');

      // 1. Initialize self-contained repo for this harness
      const res = initRepo(repo, { selfContained: true, worktrees: true, harness: h.id, homeDir: fakeHome });
      assert.equal(res.hooksConfigured, true);
      assert.equal(isSelfContainedRepo(repo), true);

      // Verify .rig/ layout
      for (const f of VENDORED_RIG_FILES) {
        assert.ok(existsSync(path.join(repo, f.dest)), `expected ${f.dest} to exist in self-contained repo for ${h.id}`);
      }
      assert.ok(existsSync(path.join(repo, '.rig/hooks/pre-commit')));

      // Verify harness dotDir layout
      const dotPath = path.join(repo, h.dotDir);
      assert.ok(existsSync(path.join(dotPath, 'skills/dispatch/SKILL.md')));
      assert.ok(existsSync(path.join(dotPath, 'agents/worker.md')));
      assert.ok(existsSync(path.join(dotPath, 'agents/verifier.md')));
      assert.ok(existsSync(path.join(dotPath, 'rules/contract-change-gate.md')));
      if (h.id === 'claude') {
        assert.ok(existsSync(path.join(dotPath, 'settings.json')));
        assert.ok(existsSync(path.join(dotPath, 'hooks/guard-remote-mutation.mjs')));
      }

      // Verify doc linters pass
      const checkDocs = runCheckDocs(repo);
      assert.equal(checkDocs.status, 0, `${h.id} checkDocs failed: ${checkDocs.stdout}${checkDocs.stderr}`);
      const reflowDocs = runReflowDocs(repo, { check: true });
      assert.equal(reflowDocs.status, 0, `${h.id} reflowDocs failed: ${reflowDocs.stdout}${reflowDocs.stderr}`);

      // Commit initial files so working tree is clean on main
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'chore: initial self-contained setup');

      // 2. Tamper with a vendored .rig file and a vendored harness skill, commit them, and verify update auto-commits on main
      writeFileSync(path.join(repo, '.rig/bin/rig.mjs'), '#!/usr/bin/env node\n// outdated vendored rig\n');
      writeFileSync(path.join(dotPath, 'skills/dispatch/SKILL.md'), '# outdated dispatch skill\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'chore: tamper vendored files');

      const pending = checkRepoPendingUpdates(repo, { harness: h.id });
      assert.equal(pending.hasPendingUpdates, true);
      assert.ok(pending.pendingFiles.some((f) => f.endsWith('.rig/bin/rig.mjs')));
      assert.ok(pending.pendingFiles.some((f) => f.endsWith('skills/dispatch/SKILL.md')));

      const upd = updateRepo(repo, { harness: h.id, autoCommit: true, homeDir: fakeHome });
      assert.equal(upd.committed, true, upd.commitError);
      assert.ok(upd.copied.some((f) => f.endsWith('.rig/bin/rig.mjs')));
      assert.doesNotMatch(readFileSync(path.join(repo, '.rig/bin/rig.mjs'), 'utf8'), /\/\/ outdated vendored rig/);
      assert.doesNotMatch(readFileSync(path.join(dotPath, 'skills/dispatch/SKILL.md'), 'utf8'), /# outdated dispatch skill/);
      assert.equal(checkRepoPendingUpdates(repo, { harness: h.id }).hasPendingUpdates, false);
      assert.equal(git(repo, 'status', '--porcelain').stdout.trim(), '');

      // 3. Test rig attach: detach HEAD and unset hooksPath, then attach restores them
      git(repo, 'checkout', '--detach', 'HEAD');
      git(repo, 'config', '--unset', 'core.hooksPath');
      const attachRes = attachRepo(repo, { homeDir: fakeHome });
      assert.equal(attachRes.hooksConfigured, true);
      assert.equal(attachRes.mainCheckoutHead.status, 'attached');
      assert.equal(git(repo, 'config', '--get', 'core.hooksPath').stdout.trim(), '.rig/hooks');
      assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), 'main');
      assert.ok(readRigState(fakeHome).initializedRepos.includes(repo));

      // 4. Test rig eject: unsets hooksPath, deletes .rig, prunes state, preserves AGENTS.md and docs
      const ejectRes = ejectRepo(repo, { homeDir: fakeHome });
      assert.equal(ejectRes.hooksUnset, true);
      assert.equal(existsSync(path.join(repo, '.rig')), false);
      assert.equal(git(repo, 'config', '--get', 'core.hooksPath').stdout.trim(), '');
      assert.equal(readRigState(fakeHome).initializedRepos.includes(repo), false);
      assert.equal(isRiggedRepo(repo), false);
      assert.ok(existsSync(path.join(repo, 'AGENTS.md')));
      assert.ok(existsSync(path.join(repo, 'docs/backlog.md')));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }
});

test('non-rig machine simulation with sanitized PATH and isolated empty HOME protects main/master while allowing feature and merge commits', () => {
  const PRE_COMMIT = path.resolve(RIG_ROOT, '.rig/hooks/pre-commit');

  // Subcase A: Pure shell fallback (no rig, no node on PATH) across both main and master
  for (const branchName of ['main', 'master']) {
    const root = mkdtempSync(path.join(tmpdir(), `rig-nonrig-${branchName}-`));
    const emptyHome = mkdtempSync(path.join(tmpdir(), 'rig-empty-home-'));
    const safeEnv = {
      PATH: '/usr/bin:/bin',
      HOME: emptyHome,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: safeEnv });
    try {
      git(root, 'init', '-q', '-b', branchName);
      git(root, 'config', 'user.email', 'test@example.com');
      git(root, 'config', 'user.name', 'Test');

      // Standard lightweight rigged repo: pre-commit shim only, NO .rig/bin/rig.mjs
      mkdirSync(path.join(root, '.rig/hooks'), { recursive: true });
      copyFileSync(PRE_COMMIT, path.join(root, '.rig/hooks/pre-commit'));
      chmodSync(path.join(root, '.rig/hooks/pre-commit'), 0o755);
      git(root, 'config', 'core.hooksPath', '.rig/hooks');

      // 1. Initial commit on unborn repo succeeds on main/master
      writeFileSync(path.join(root, 'init.txt'), 'initial');
      git(root, 'add', 'init.txt');
      const initRes = git(root, 'commit', '-m', 'chore: initial commit');
      assert.equal(initRes.status, 0, initRes.stderr);

      // 2. Direct non-merge commit on main/master is refused
      writeFileSync(path.join(root, 'init.txt'), 'illegal change');
      git(root, 'add', 'init.txt');
      const directRes = git(root, 'commit', '-m', 'illegal direct commit');
      assert.notEqual(directRes.status, 0);
      assert.match(directRes.stderr, new RegExp(`pre-commit: refusing direct commit in the main checkout on ${branchName}\\.`));
      git(root, 'reset', '--hard', 'HEAD');

      // 3. Commit on feature branch is permitted
      git(root, 'checkout', '-b', `feature/test-${branchName}`);
      writeFileSync(path.join(root, 'feat.txt'), 'feature content');
      git(root, 'add', 'feat.txt');
      const featRes = git(root, 'commit', '-m', 'feat: feature branch commit');
      assert.equal(featRes.status, 0, featRes.stderr);

      // 4. Merge commit onto main/master is permitted
      git(root, 'checkout', branchName);
      const mergeNoCommit = git(root, 'merge', '--no-commit', '--no-ff', `feature/test-${branchName}`);
      assert.equal(mergeNoCommit.status, 0, mergeNoCommit.stderr);
      const mergeRes = git(root, 'commit', '-m', `Merge branch 'feature/test-${branchName}' into ${branchName}`);
      assert.equal(mergeRes.status, 0, mergeRes.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(emptyHome, { recursive: true, force: true });
    }
  }

  // Subcase B: Non-rig machine with self-contained repo fallback (node is available, but NO rig CLI on PATH, empty HOME)
  const selfRepo = mkdtempSync(path.join(tmpdir(), 'rig-sim-self-'));
  const selfEmptyHome = mkdtempSync(path.join(tmpdir(), 'rig-sim-home-'));
  const isolatedNodeBin = mkdtempSync(path.join(tmpdir(), 'rig-sim-node-'));
  symlinkSync(process.execPath, path.join(isolatedNodeBin, 'node'));

  const nodeEnv = {
    PATH: `${isolatedNodeBin}:/usr/bin:/bin`,
    HOME: selfEmptyHome,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const gitNode = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: nodeEnv });
  try {
    gitNode(selfRepo, 'init', '-q', '-b', 'main');
    gitNode(selfRepo, 'config', 'user.email', 'test@example.com');
    gitNode(selfRepo, 'config', 'user.name', 'Test');
    initRepo(selfRepo, { selfContained: true, worktrees: true, harness: 'antigravity', homeDir: false });

    // Initial commit
    gitNode(selfRepo, 'add', '-A');
    const initCommit = gitNode(selfRepo, 'commit', '-m', 'chore: initial self-contained setup');
    assert.equal(initCommit.status, 0, initCommit.stderr);

    // 1. Direct code commit on main in root checkout is refused by runPreCommitHook via vendored rig.mjs
    writeFileSync(path.join(selfRepo, 'app.js'), 'console.log("direct root edit");\n');
    gitNode(selfRepo, 'add', 'app.js');
    const directRes = gitNode(selfRepo, 'commit', '-m', 'feat: direct root commit');
    assert.notEqual(directRes.status, 0);
    assert.match(directRes.stderr, /refusing direct commit in the main checkout/);
    gitNode(selfRepo, 'reset', '--hard', 'HEAD');

    // 2. Doc-only commit on main in root checkout passes doc linters and succeeds
    writeFileSync(path.join(selfRepo, 'docs/backlog.md'), '# Backlog\n\n- Task 1.\n');
    gitNode(selfRepo, 'add', 'docs/backlog.md');
    const docCommit = gitNode(selfRepo, 'commit', '-m', 'docs: update backlog');
    assert.equal(docCommit.status, 0, docCommit.stderr);

    // 3. Feature branch in linked worktree: feature commit succeeds, merge commit onto main succeeds
    const wt = path.join(selfRepo, '.worktrees/sim-wt');
    gitNode(selfRepo, 'worktree', 'add', '-q', '-b', 'feature/sim-feature', wt, 'main');
    writeFileSync(path.join(wt, 'feature.js'), 'export const feat = true;\n');
    const gitWt = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: nodeEnv });
    gitWt(wt, 'add', 'feature.js');
    const featCommit = gitWt(wt, 'commit', '-m', 'feat: feature commit');
    assert.equal(featCommit.status, 0, featCommit.stderr);

    const mergeNoCommit = gitNode(selfRepo, 'merge', '--no-commit', '--no-ff', 'feature/sim-feature');
    assert.equal(mergeNoCommit.status, 0, mergeNoCommit.stderr);
    const mergeCommit = gitNode(selfRepo, 'commit', '-m', "Merge branch 'feature/sim-feature' into main");
    assert.equal(mergeCommit.status, 0, mergeCommit.stderr);
  } finally {
    rmSync(selfRepo, { recursive: true, force: true });
    rmSync(selfEmptyHome, { recursive: true, force: true });
    rmSync(isolatedNodeBin, { recursive: true, force: true });
  }
});

test('CLI rig update --all and rig update --repo update clean repos on main and reject dirty or feature branch repos with warnings without mutating files', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-cli-upd-home-'));
  const cleanRepo = mkdtempSync(path.join(tmpdir(), 'rig-cli-clean-'));
  const dirtyRepo = mkdtempSync(path.join(tmpdir(), 'rig-cli-dirty-'));
  const branchRepo = mkdtempSync(path.join(tmpdir(), 'rig-cli-branch-'));

  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const runRig = (...args) =>
    spawnSync(process.execPath, [path.join(RIG_ROOT, 'bin/rig.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
    });

  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    installRig({ homeDir: fakeHome, harnesses: ['antigravity'] });

    for (const r of [cleanRepo, dirtyRepo, branchRepo]) {
      git(r, 'init', '-q', '-b', 'main');
      git(r, 'config', 'user.email', 'test@example.com');
      git(r, 'config', 'user.name', 'Test');
      initRepo(r, { selfContained: false, worktrees: true, homeDir: fakeHome });
      git(r, 'add', '-A');
      git(r, 'commit', '-qm', 'chore: initial');

      // Make .rig/hooks/pre-commit outdated in all 3 repos and commit so working trees start clean
      writeFileSync(path.join(r, '.rig/hooks/pre-commit'), '#!/bin/sh\n# outdated shim\n');
      git(r, 'add', '-A');
      git(r, 'commit', '-qm', 'chore: outdated shim');
    }

    // Put branchRepo on feature branch
    git(branchRepo, 'checkout', '-b', 'feature/isolated-branch');

    // Make dirtyRepo dirty with uncommitted changes
    writeFileSync(path.join(dirtyRepo, 'uncommitted.txt'), 'dirty uncommitted work\n');

    // 1. CLI rig update --repo targeting dirtyRepo
    const dirtyRes = runRig('update', '--repo', dirtyRepo, '--home', fakeHome);
    assert.match(dirtyRes.stderr + dirtyRes.stdout, /working tree has uncommitted changes/);
    // Crucial: file must NOT have been mutated
    assert.match(readFileSync(path.join(dirtyRepo, '.rig/hooks/pre-commit'), 'utf8'), /# outdated shim/);

    // 2. CLI rig update --repo targeting branchRepo
    const branchRes = runRig('update', '--repo', branchRepo, '--home', fakeHome);
    assert.match(branchRes.stderr + branchRes.stdout, /active branch is 'feature\/isolated-branch'/);
    // Crucial: file must NOT have been mutated
    assert.match(readFileSync(path.join(branchRepo, '.rig/hooks/pre-commit'), 'utf8'), /# outdated shim/);

    // 3. CLI rig update --repo targeting cleanRepo
    const cleanRes = runRig('update', '--repo', cleanRepo, '--home', fakeHome);
    assert.match(cleanRes.stdout, /rig update: synced/);
    assert.doesNotMatch(readFileSync(path.join(cleanRepo, '.rig/hooks/pre-commit'), 'utf8'), /# outdated shim/);
    assert.equal(git(cleanRepo, 'status', '--porcelain').stdout.trim(), '');
    const cleanCommitMsg = git(cleanRepo, 'log', '-1', '--pretty=%B').stdout.trim();
    assert.match(cleanCommitMsg, /chore\(rig\): update agent-rig repository assets/);
    assert.match(cleanCommitMsg, /Unmandated-call: none/);

    // 4. CLI rig update --all
    // Make cleanRepo outdated again so we can test --all
    writeFileSync(path.join(cleanRepo, '.rig/hooks/pre-commit'), '#!/bin/sh\n# outdated again\n');
    git(cleanRepo, 'add', '-A');
    git(cleanRepo, 'commit', '-qm', 'chore: outdated again');

    const allRes = runRig('update', '--all', '--home', fakeHome);
    assert.match(allRes.stdout, /rig update: synced/);
    assert.match(allRes.stderr + allRes.stdout, /working tree has uncommitted changes/);
    assert.match(allRes.stderr + allRes.stdout, /active branch is 'feature\/isolated-branch'/);

    // cleanRepo updated and auto-committed, dirtyRepo and branchRepo still untouched
    assert.doesNotMatch(readFileSync(path.join(cleanRepo, '.rig/hooks/pre-commit'), 'utf8'), /# outdated again/);
    assert.equal(git(cleanRepo, 'status', '--porcelain').stdout.trim(), '');
    const allCommitMsg = git(cleanRepo, 'log', '-1', '--pretty=%B').stdout.trim();
    assert.match(allCommitMsg, /chore\(rig\): update agent-rig repository assets/);
    assert.match(readFileSync(path.join(dirtyRepo, '.rig/hooks/pre-commit'), 'utf8'), /# outdated shim/);
    assert.match(readFileSync(path.join(branchRepo, '.rig/hooks/pre-commit'), 'utf8'), /# outdated shim/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(cleanRepo, { recursive: true, force: true });
    rmSync(dirtyRepo, { recursive: true, force: true });
    rmSync(branchRepo, { recursive: true, force: true });
  }
});

test('rig handles foreign system, editor, and metadata files without throwing ENOTDIR or EISDIR', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-foreign-'));
  const fakeRigRoot = mkdtempSync(path.join(tmpdir(), 'rig-root-foreign-'));

  try {
    // Scaffold minimal rig structure in fakeRigRoot
    mkdirSync(path.join(fakeRigRoot, 'templates'), { recursive: true });
    copyFileSync(path.join(RIG_ROOT, 'templates/models.json'), path.join(fakeRigRoot, 'templates/models.json'));
    copyFileSync(path.join(RIG_ROOT, 'templates/rig-config.default.json'), path.join(fakeRigRoot, 'templates/rig-config.default.json'));
    copyFileSync(path.join(RIG_ROOT, 'plugin.json'), path.join(fakeRigRoot, 'plugin.json'));

    mkdirSync(path.join(fakeRigRoot, 'skills/dispatch'), { recursive: true });
    writeFileSync(path.join(fakeRigRoot, 'skills/dispatch/SKILL.md'), '# Dispatch\n');
    mkdirSync(path.join(fakeRigRoot, 'skills/wrap-up'), { recursive: true });
    writeFileSync(path.join(fakeRigRoot, 'skills/wrap-up/SKILL.md'), '# Wrap up\n');

    // Plant foreign system files in skills/
    writeFileSync(path.join(fakeRigRoot, 'skills/.DS_Store'), 'macos metadata');
    writeFileSync(path.join(fakeRigRoot, 'skills/.directory'), 'kde metadata');
    writeFileSync(path.join(fakeRigRoot, 'skills/desktop.ini'), 'windows metadata');
    writeFileSync(path.join(fakeRigRoot, 'skills/Thumbs.db'), 'windows thumbnails');
    writeFileSync(path.join(fakeRigRoot, 'skills/notes.txt'), 'not a skill\n');

    // Plant editor artifacts inside skill directories
    writeFileSync(path.join(fakeRigRoot, 'skills/dispatch/.DS_Store'), 'nested macos metadata');
    writeFileSync(path.join(fakeRigRoot, 'skills/dispatch/SKILL.md~'), 'backup');
    writeFileSync(path.join(fakeRigRoot, 'skills/dispatch/.SKILL.md.swp'), 'vim swap');

    // Plant rules and agents with foreign artifacts
    mkdirSync(path.join(fakeRigRoot, 'rules'), { recursive: true });
    writeFileSync(path.join(fakeRigRoot, 'rules/contract-change-gate.md'), '# Contract Gate\n');
    writeFileSync(path.join(fakeRigRoot, 'rules/.DS_Store'), 'macos metadata');
    writeFileSync(path.join(fakeRigRoot, 'rules/.directory'), 'kde metadata');
    writeFileSync(path.join(fakeRigRoot, 'rules/contract-change-gate.md~'), 'backup');

    mkdirSync(path.join(fakeRigRoot, 'agents'), { recursive: true });
    writeFileSync(path.join(fakeRigRoot, 'agents/verifier.md'), '# Verifier\n');
    writeFileSync(path.join(fakeRigRoot, 'agents/.DS_Store'), 'macos metadata');
    writeFileSync(path.join(fakeRigRoot, 'agents/verifier.md~'), 'backup');

    // 1. Verify listSkills filters all non-skill and foreign entries
    const skills = listSkills(path.join(fakeRigRoot, 'skills'));
    assert.deepEqual(skills, ['dispatch', 'wrap-up']);

    // 2. Verify isIgnoredFsEntry
    assert.equal(isIgnoredFsEntry('.DS_Store'), true);
    assert.equal(isIgnoredFsEntry('.directory'), true);
    assert.equal(isIgnoredFsEntry('desktop.ini'), true);
    assert.equal(isIgnoredFsEntry('Thumbs.db'), true);
    assert.equal(isIgnoredFsEntry('SKILL.md~'), true);
    assert.equal(isIgnoredFsEntry('#SKILL.md#'), true);
    assert.equal(isIgnoredFsEntry('SKILL.md.swp'), true);
    assert.equal(isIgnoredFsEntry('SKILL.md.orig'), true);
    assert.equal(isIgnoredFsEntry('SKILL.md'), false);
    assert.equal(isIgnoredFsEntry('dispatch'), false);

    // 3. installRig must succeed without ENOTDIR / EISDIR
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    const res = installRig({
      homeDir: fakeHome,
      harnesses: ['antigravity'],
      force: false,
      rigRoot: fakeRigRoot,
    });
    assert.ok(res);

    // Verify installed plugin does not contain foreign artifacts
    const installedSkills = readdirSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig/skills'));
    assert.deepEqual(installedSkills.sort(), ['dispatch', 'wrap-up']);
    assert.equal(existsSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig/skills/.DS_Store')), false);
    assert.equal(existsSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig/skills/dispatch/.DS_Store')), false);
    assert.equal(existsSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig/skills/dispatch/SKILL.md~')), false);

    const installedRules = readdirSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig/rules'));
    assert.deepEqual(installedRules, ['contract-change-gate.md']);

    const installedAgents = readdirSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig/agents'));
    assert.deepEqual(installedAgents, ['verifier.md']);

    // 4. updateRig must also succeed cleanly with foreign metadata/editor files
    const updateRes = updateRig({
      homeDir: fakeHome,
      rigRoot: fakeRigRoot,
    });
    assert.ok(updateRes);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeRigRoot, { recursive: true, force: true });
  }
});



