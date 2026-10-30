import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RIG_ROOT,
  detectHarnesses,
  installRig,
  updateRig,
  readRigState,
  initRepo,
  statusRepo,
  runCheckDocs,
  runReflowDocs,
} from '../bin/rig.mjs';

test('detectHarnesses, installRig, and updateRig manage state, link verifier subagent, and prune dangling symlinks', () => {
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
    assert.ok(lstatSync(path.join(fakeHome, '.local/bin/rig')).isSymbolicLink());

    const state = readRigState(fakeHome);
    assert.deepEqual(state.installedHarnesses, ['antigravity', 'claude']);

    // Antigravity plugin symlink + plugins.json
    assert.ok(lstatSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig')).isSymbolicLink());
    const pluginsJson = JSON.parse(readFileSync(path.join(fakeHome, '.gemini/config/plugins.json'), 'utf8'));
    assert.equal(pluginsJson.entries.length, 1);

    // Claude skills, verifier subagent, and settings.json
    assert.ok(lstatSync(path.join(fakeHome, '.claude/skills/dispatch')).isSymbolicLink());
    assert.ok(lstatSync(path.join(fakeHome, '.claude/agents/verifier.md')).isSymbolicLink());
    const claudeSettings = JSON.parse(readFileSync(path.join(fakeHome, '.claude/settings.json'), 'utf8'));
    assert.equal(claudeSettings.hooks.PreToolUse.length, 2);

    // Plant a dangling symlink pointing inside RIG_ROOT and verify updateRig prunes it without prompting
    const dangling = path.join(fakeHome, '.claude/skills/removed-skill');
    symlinkSync(path.join(RIG_ROOT, 'skills/does-not-exist'), dangling);
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
    assert.equal(st.skillsPresent.length, 6);
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
