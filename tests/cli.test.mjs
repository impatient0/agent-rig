import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RIG_ROOT,
  detectHarnesses,
  installGlobal,
  initRepo,
  statusRepo,
  runCheckDocs,
  runReflowDocs,
} from '../bin/rig.mjs';

test('detectHarnesses and installGlobal configure Antigravity, Claude Code, Codex, and Cursor in an isolated home directory', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-home-'));
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });

    const detected = detectHarnesses(fakeHome);
    assert.equal(detected.find((h) => h.id === 'antigravity').detected, true);
    assert.equal(detected.find((h) => h.id === 'claude').detected, true);
    assert.equal(detected.find((h) => h.id === 'codex').detected, false);

    const res = installGlobal({ homeDir: fakeHome, detectedOnly: true });
    assert.deepEqual(res.installedHarnesses, ['antigravity', 'claude']);

    // Antigravity plugin symlink + plugins.json
    assert.ok(lstatSync(path.join(fakeHome, '.gemini/config/plugins/agent-rig')).isSymbolicLink());
    const pluginsJson = JSON.parse(readFileSync(path.join(fakeHome, '.gemini/config/plugins.json'), 'utf8'));
    assert.equal(pluginsJson.entries.length, 1);

    // Claude skills + settings.json
    assert.ok(lstatSync(path.join(fakeHome, '.claude/skills/dispatch')).isSymbolicLink());
    const claudeSettings = JSON.parse(readFileSync(path.join(fakeHome, '.claude/settings.json'), 'utf8'));
    assert.equal(claudeSettings.hooks.PreToolUse.length, 2);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
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

test('self-contained initRepo bundles skills, rules, hooks, and linters into the target repo', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rig-init-self-'));
  try {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    initRepo(dir, { selfContained: true, worktrees: true });
    const st = statusRepo(dir);
    assert.equal(st.skillsPresent.length, 6);
    assert.equal(st.hooksPresent.length, 3);

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
  assert.equal(claudePlugin.hooks, './hooks/claude-hooks.json');
  assert.ok(existsSync(path.join(RIG_ROOT, claudePlugin.skills, 'dispatch/SKILL.md')));
  assert.ok(existsSync(path.join(RIG_ROOT, claudePlugin.hooks)));
});
