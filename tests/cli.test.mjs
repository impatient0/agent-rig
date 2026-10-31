import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
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
  statusRepo,
  runCheckDocs,
  runReflowDocs,
  normalizeGitignore,
  detachMainCheckout,
  INIT_WORKTREE_BRANCH,
  loadCatalog,
  resolveSubagentModel,
  resolveProfile,
  hydrateText,
  listProfiles,
  useProfile,
  setProfileRole,
  resolveRoleModel,
} from '../bin/rig.mjs';

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

test('detachMainCheckout parks HEAD even when untracked files are present, but not over tracked edits', () => {
  const { root, cleanup } = makeRepoWithHistory('rig-detach-');
  try {
    writeFileSync(path.join(root, 'scratch.txt'), 'untracked\n');
    assert.equal(detachMainCheckout(root).status, 'detached');

    spawnSync('git', ['switch', '-q', 'main'], { cwd: root });
    writeFileSync(path.join(root, 'app.js'), 'console.log(2);\n');
    assert.equal(detachMainCheckout(root).status, 'dirty');
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
    assert.ok(existsSync(path.join(wt, 'scripts/git-hooks/pre-commit')));
    assert.equal(existsSync(path.join(root, 'AGENTS.md')), false);

    // The worktree shares node_modules through a symlink, and .gitignore covers both it and .worktrees/.
    assert.ok(lstatSync(path.join(wt, 'node_modules')).isSymbolicLink());
    assert.equal(readFileSync(path.join(wt, '.gitignore'), 'utf8'), 'node_modules\n*.log\n.worktrees/\n');

    // The main checkout is parked detached, and the worktree stays on its branch.
    assert.equal(res.worktreeHead.status, 'detached');
    assert.notEqual(git(root, 'symbolic-ref', '-q', 'HEAD').status, 0);
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

test('initRepo targeting a linked worktree scaffolds in place and parks the main checkout', () => {
  const { root, git, cleanup } = makeRepoWithHistory('rig-init-linked-');
  try {
    const wt = path.join(root, '.worktrees/onboard');
    git(root, 'worktree', 'add', '-q', '-b', 'chore/onboard', wt, 'main');
    const res = initRepo(wt, { worktrees: true });
    assert.equal(res.initWorktree, null);
    assert.equal(res.dir, wt);
    assert.ok(existsSync(path.join(wt, 'AGENTS.md')));
    assert.equal(res.worktreeHead.status, 'detached');
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
    const symlinkedBin = path.join(fakeHome, '.local/bin/rig');
    assert.ok(lstatSync(symlinkedBin).isSymbolicLink());

    // Invoking rig via symlink (like npm link or ~/.local/bin/rig) must execute main()
    const cliRun = spawnSync(symlinkedBin, ['status', RIG_ROOT], { encoding: 'utf8' });
    assert.equal(cliRun.status, 0, cliRun.stderr);
    assert.equal(JSON.parse(cliRun.stdout).hasAgentsMd, true);

    const state = readRigState(fakeHome);
    assert.deepEqual(state.installedHarnesses, ['antigravity', 'claude']);
    assert.ok(state.installedSkills.includes('dispatch'));

    // Antigravity plugin directory with hydrated files, symlinked hooks, and plugins.json
    const agyPluginDir = path.join(fakeHome, '.gemini/config/plugins/agent-rig');
    assert.equal(lstatSync(agyPluginDir).isSymbolicLink(), false);
    assert.ok(lstatSync(path.join(agyPluginDir, 'hooks')).isSymbolicLink());
    const agyAgents = readFileSync(path.join(agyPluginDir, 'rules/AGENTS.md'), 'utf8');
    assert.match(agyAgents, /antigravity-budget/);
    assert.equal(agyAgents.includes('{{'), false);
    const agyVerifier = readFileSync(path.join(agyPluginDir, 'agents/verifier.md'), 'utf8');
    assert.match(agyVerifier, /gemini-3-8-flash/);
    assert.equal(agyVerifier.includes('{{'), false);
    const pluginsJson = JSON.parse(readFileSync(path.join(fakeHome, '.gemini/config/plugins.json'), 'utf8'));
    assert.equal(pluginsJson.entries.length, 1);

    // Claude hydrated skills, verifier subagent, and settings.json
    assert.equal(lstatSync(path.join(fakeHome, '.claude/skills/dispatch')).isSymbolicLink(), false);
    const claudeSkill = readFileSync(path.join(fakeHome, '.claude/skills/dispatch/SKILL.md'), 'utf8');
    assert.match(claudeSkill, /claude-sonnet-5-5/);
    assert.equal(claudeSkill.includes('{{'), false);
    const claudeVerifier = readFileSync(path.join(fakeHome, '.claude/agents/verifier.md'), 'utf8');
    assert.match(claudeVerifier, /model: sonnet/);
    assert.equal(claudeVerifier.includes('{{'), false);
    const claudeSettings = JSON.parse(readFileSync(path.join(fakeHome, '.claude/settings.json'), 'utf8'));
    assert.equal(claudeSettings.hooks.PreToolUse.length, 2);

    // Plant a dangling symlink and verify updateRig prunes it without prompting
    const dangling = path.join(fakeHome, '.claude/hooks/removed-hook');
    symlinkSync(path.join(RIG_ROOT, 'hooks/does-not-exist'), dangling);
    assert.ok(lstatSync(dangling).isSymbolicLink());

    const upd = updateRig({ homeDir: fakeHome });
    assert.deepEqual(upd.installedHarnesses, ['antigravity', 'claude']);
    assert.deepEqual(upd.pruned, [dangling]);
    assert.equal(existsSync(dangling), false);
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
    initRepo(repo, { selfContained: false, worktrees: true, homeDir: fakeHome });

    // User customizes AGENTS.md and docs/backlog.md
    writeFileSync(path.join(repo, 'AGENTS.md'), '# Custom Project Rules\n');
    writeFileSync(path.join(repo, 'docs/backlog.md'), '# Custom Backlog\n');
    // Simulate an outdated pre-commit hook
    writeFileSync(path.join(repo, 'scripts/git-hooks/pre-commit'), '#!/bin/sh\n# old\n');

    const upd = updateRig({ homeDir: fakeHome });
    assert.equal(upd.updatedRepos.length, 1);
    assert.equal(readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), '# Custom Project Rules\n');
    assert.equal(readFileSync(path.join(repo, 'docs/backlog.md'), 'utf8'), '# Custom Backlog\n');
    assert.match(readFileSync(path.join(repo, 'scripts/git-hooks/pre-commit'), 'utf8'), /refusing to commit in the main checkout/);
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

test('self-contained initRepo bundles skills, verifier subagent, rules, hooks, and linters into the target repo', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rig-init-self-'));
  try {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    initRepo(dir, { selfContained: true, worktrees: true });
    const st = statusRepo(dir);
    assert.equal(st.skillsPresent.length, readdirSync(path.join(RIG_ROOT, 'skills')).length);
    assert.ok(st.skillsPresent.includes('rig-onboard'));
    assert.equal(st.hooksPresent.length, 3);
    assert.ok(existsSync(path.join(dir, 'agents/verifier.md')));

    const checkLinks = runCheckDocs(dir);
    assert.equal(checkLinks.status, 0, `${checkLinks.stdout}${checkLinks.stderr}`);
    const checkFormat = runReflowDocs(dir, { check: true });
    assert.equal(checkFormat.status, 0, `${checkFormat.stdout}${checkFormat.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    const hydratedAgents = readFileSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig/rules/AGENTS.md'), 'utf8');
    assert.match(hydratedAgents, /Profile: antigravity-pro/);
    assert.match(hydratedAgents, /Worker: gemini-4-argon/);

    // Update role in profile
    setProfileRole('worker', 'claude-opus-5-5', { effort: 'medium', rigRoot: fakeRig, homeDir: fakeHome, harness: 'antigravity' });
    const afterSet = resolveRoleModel('worker', { harness: 'antigravity', rigRoot: fakeRig });
    assert.equal(afterSet.model, 'claude-opus-5-5');
    assert.equal(afterSet.subagentModel, 'pro'); // claude-opus-5-5 mapped to pro on antigravity
    assert.equal(afterSet.effort, 'medium');

    const rehydratedAgents = readFileSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig/rules/AGENTS.md'), 'utf8');
    assert.match(rehydratedAgents, /Worker: claude-opus-5-5/);
  } finally {
    rmSync(fakeRig, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
