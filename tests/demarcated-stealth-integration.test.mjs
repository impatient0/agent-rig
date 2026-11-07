import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  initRepo,
  updateRig,
  installRig,
  ejectRepo,
  buildManagedAgentsBlock,
  extractManagedAgentsBlock,
  mergeManagedAgentsFile,
  resolveProfile,
  RIG_ROOT,
} from '../bin/rig.mjs';
import { checkEditTarget } from '../hooks/guard-main-checkout-edits.mjs';

function makeTestEnv(fakeHome) {
  const binDir = mkdtempSync(path.join(tmpdir(), 'rig-test-bin-'));
  const rigWrapper = path.join(binDir, 'rig');
  writeFileSync(
    rigWrapper,
    `#!/usr/bin/env sh\nexec node "${path.join(RIG_ROOT, 'bin/rig.mjs')}" "$@"\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: fakeHome,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const cleanup = () => rmSync(binDir, { recursive: true, force: true });
  return { env, cleanup };
}

function gitCmd(cwd, envOrArg, ...rest) {
  let env = process.env;
  let args = [];
  if (typeof envOrArg === 'object' && envOrArg !== null && !Array.isArray(envOrArg)) {
    env = envOrArg;
    args = rest;
  } else {
    args = [envOrArg, ...rest];
  }
  return spawnSync('git', args, { cwd, encoding: 'utf8', env });
}

test('integration: pre-commit hook rejects manual edits to AGENTS.md managed block but allows project context edits', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-integ-home-'));
  const repo = mkdtempSync(path.join(tmpdir(), 'rig-integ-repo-'));
  const { env, cleanup: cleanupEnv } = makeTestEnv(fakeHome);
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    installRig({ homeDir: fakeHome, harnesses: ['antigravity'], rigRoot: RIG_ROOT });

    gitCmd(repo, env, 'init', '-q', '-b', 'main');
    gitCmd(repo, env, 'config', 'user.email', 'test@example.com');
    gitCmd(repo, env, 'config', 'user.name', 'Test');
    initRepo(repo, { selfContained: false, homeDir: fakeHome, rigRoot: RIG_ROOT });

    // Initial commit on main
    gitCmd(repo, env, 'add', '-A');
    const initCommit = gitCmd(repo, env, 'commit', '-m', 'chore: initial');
    assert.equal(initCommit.status, 0, initCommit.stderr);

    const agentsPath = path.join(repo, 'AGENTS.md');
    const originalContent = readFileSync(agentsPath, 'utf8');
    assert.ok(originalContent.includes('<!-- AGENT-RIG:START -->'));

    // 1. Manually tamper inside the managed block
    const tampered = originalContent.replace(
      'Never speculate about code',
      'Always speculate wildly about code',
    );
    writeFileSync(agentsPath, tampered, 'utf8');
    gitCmd(repo, env, 'add', 'AGENTS.md');

    const badCommit = gitCmd(repo, env, 'commit', '-m', 'docs: tamper with managed block');
    assert.notEqual(badCommit.status, 0);
    assert.match(
      badCommit.stdout + badCommit.stderr,
      /refusing commit with modified agent-rig managed block in AGENTS\.md/,
    );

    // 2. Revert tampering and modify only the Project Context section below the block
    writeFileSync(
      agentsPath,
      originalContent + '\n## Project Custom Guidelines\n- Follow standard style.\n',
      'utf8',
    );
    gitCmd(repo, env, 'add', 'AGENTS.md');

    const goodCommit = gitCmd(repo, env, 'commit', '-m', 'docs: update project context in AGENTS.md');
    assert.equal(goodCommit.status, 0, goodCommit.stderr);

    const log = gitCmd(repo, env, 'log', '-1', '--pretty=%B').stdout;
    assert.match(log, /docs: update project context in AGENTS\.md/);
  } finally {
    cleanupEnv();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('integration: rig update refreshes the demarcated AGENTS.md block and auto-commits on main', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-upd-integ-home-'));
  const repo = mkdtempSync(path.join(tmpdir(), 'rig-upd-integ-repo-'));
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    installRig({ homeDir: fakeHome, harnesses: ['antigravity'] });

    gitCmd(repo, 'init', '-q', '-b', 'main');
    gitCmd(repo, 'config', 'user.email', 'test@example.com');
    gitCmd(repo, 'config', 'user.name', 'Test');
    initRepo(repo, { selfContained: false, homeDir: fakeHome });

    // Initial commit
    gitCmd(repo, 'add', '-A');
    gitCmd(repo, 'commit', '-m', 'chore: initial');

    const agentsPath = path.join(repo, 'AGENTS.md');
    const initialContent = readFileSync(agentsPath, 'utf8');

    // Simulate an outdated / modified managed block in AGENTS.md (e.g. older rig version)
    const outdated = initialContent.replace(
      '<!-- Managed by `rig init` / `rig update`. Do not edit between AGENT-RIG:START and AGENT-RIG:END. -->',
      '<!-- Managed by `rig init` / `rig update`. Outdated signature v0. -->',
    );
    writeFileSync(agentsPath, outdated, 'utf8');
    gitCmd(repo, 'add', 'AGENTS.md');
    // Commit with --no-verify to simulate historical / pulled commit
    gitCmd(repo, 'commit', '--no-verify', '-m', 'chore: simulate historical older block');

    const beforeUpdateSha = gitCmd(repo, 'rev-parse', 'HEAD').stdout.trim();

    // Run rig update targeting this repo
    const updRes = updateRig({ homeDir: fakeHome, repoDir: repo });
    assert.equal(updRes.updatedRepos.length, 1);
    assert.equal(updRes.updatedRepos[0].committed, true);

    const afterUpdateSha = gitCmd(repo, 'rev-parse', 'HEAD').stdout.trim();
    assert.notEqual(beforeUpdateSha, afterUpdateSha);

    const lastCommitMsg = gitCmd(repo, 'log', '-1', '--pretty=%B').stdout.trim();
    assert.match(lastCommitMsg, /chore\(rig\): update agent-rig repository assets/);
    assert.match(lastCommitMsg, /Unmandated-call: none/);

    const refreshedContent = readFileSync(agentsPath, 'utf8');
    assert.doesNotMatch(refreshedContent, /Outdated signature v0/);
    assert.match(refreshedContent, /Do not edit between AGENT-RIG:START and AGENT-RIG:END/);

    // Idempotent: running again produces no commit
    const noopRes = updateRig({ homeDir: fakeHome, repoDir: repo });
    assert.equal(noopRes.updatedRepos.length, 1);
    assert.equal(noopRes.updatedRepos[0].committed, false);
    assert.equal(gitCmd(repo, 'rev-parse', 'HEAD').stdout.trim(), afterUpdateSha);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('integration: rig init --stealth keeps repository 100% clean and unpolluted', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-stealth-home-'));
  const repo = mkdtempSync(path.join(tmpdir(), 'rig-stealth-repo-'));
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    installRig({ homeDir: fakeHome, harnesses: ['antigravity'] });

    gitCmd(repo, 'init', '-q', '-b', 'main');
    gitCmd(repo, 'config', 'user.email', 'test@example.com');
    gitCmd(repo, 'config', 'user.name', 'Test');
    writeFileSync(path.join(repo, 'app.js'), 'console.log("hello team");\n');
    gitCmd(repo, 'add', 'app.js');
    gitCmd(repo, 'commit', '-m', 'feat: initial team commit');

    // 1. Initialize in stealth mode
    const initRes = initRepo(repo, { stealth: true, homeDir: fakeHome });
    assert.equal(initRes.staged.length, 0);

    // Working tree must be 100% clean
    const status = gitCmd(repo, 'status', '--porcelain').stdout.trim();
    assert.equal(status, '', 'git status must be completely clean in stealth mode');

    // .gitignore must NOT be created or touched
    assert.equal(existsSync(path.join(repo, '.gitignore')), false);

    // .git/info/exclude must hold the private stealth ignore entries
    const excludeContent = readFileSync(path.join(repo, '.git/info/exclude'), 'utf8');
    assert.match(excludeContent, /# agent-rig stealth exclude/);
    assert.match(excludeContent, /^AGENTS\.md$/m);
    assert.match(excludeContent, /^\.worktrees\/$/m);
    assert.match(excludeContent, /^\.rig\/$/m);

    // Demarcated AGENTS.md must exist on disk
    const agentsPath = path.join(repo, 'AGENTS.md');
    assert.ok(existsSync(agentsPath));
    const agentsContent = readFileSync(agentsPath, 'utf8');
    assert.ok(agentsContent.includes('<!-- AGENT-RIG:START -->'));

    // Attempting `git add .` must NOT stage AGENTS.md or .rig/
    gitCmd(repo, 'add', '.');
    const stagedAfterAdd = gitCmd(repo, 'diff', '--cached', '--name-only').stdout.trim();
    assert.equal(stagedAfterAdd, '', 'git add . must not track stealth files');

    // Pre-commit hook is active in .rig/hooks/pre-commit
    assert.ok(existsSync(path.join(repo, '.rig/hooks/pre-commit')));
    assert.equal(
      gitCmd(repo, 'config', '--get', 'core.hooksPath').stdout.trim(),
      '.rig/hooks',
    );

    // 2. Stealth init must refuse to run if AGENTS.md is already tracked
    const teamRepo = mkdtempSync(path.join(tmpdir(), 'rig-team-repo-'));
    try {
      gitCmd(teamRepo, 'init', '-q', '-b', 'main');
      gitCmd(teamRepo, 'config', 'user.email', 'test@example.com');
      gitCmd(teamRepo, 'config', 'user.name', 'Test');
      writeFileSync(path.join(teamRepo, 'AGENTS.md'), '# Team Mandated Agent Workflow\n');
      gitCmd(teamRepo, 'add', 'AGENTS.md');
      gitCmd(teamRepo, 'commit', '-m', 'docs: team agents policy');

      assert.throws(
        () => initRepo(teamRepo, { stealth: true, homeDir: fakeHome }),
        /Cannot initialize in stealth mode: AGENTS\.md is already tracked in Git/,
      );
    } finally {
      rmSync(teamRepo, { recursive: true, force: true });
    }

    // 3. Ejecting a stealth repo cleans up .git/info/exclude and .rig/
    ejectRepo(repo, { homeDir: fakeHome });
    assert.equal(existsSync(path.join(repo, '.rig')), false);
    assert.equal(gitCmd(repo, 'config', '--get', 'core.hooksPath').stdout.trim(), '');

    const excludeAfterEject = readFileSync(path.join(repo, '.git/info/exclude'), 'utf8');
    assert.doesNotMatch(excludeAfterEject, /# agent-rig stealth exclude/);
    assert.doesNotMatch(excludeAfterEject, /^AGENTS\.md$/m);

    // After eject, AGENTS.md and docs/ are preserved as durable documentation
    assert.ok(existsSync(path.join(repo, 'AGENTS.md')));
    assert.ok(existsSync(path.join(repo, 'docs')));
    // Since exclude was cleaned up, git status shows the preserved docs
    const statusAfterEject = gitCmd(repo, 'status', '--porcelain').stdout.trim();
    assert.match(statusAfterEject, /AGENTS\.md/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('integration: unrigged repositories are completely exempt from global rules and context pollution', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'rig-unrigged-home-'));
  const unriggedRepo = mkdtempSync(path.join(tmpdir(), 'rig-doc-repo-'));
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    installRig({ homeDir: fakeHome, harnesses: ['antigravity', 'claude'] });

    // 1. Verify that global configurations do NOT contain global AGENTS.md
    const agyRulesAgents = path.join(fakeHome, '.gemini/config/plugins/agent-rig/rules/AGENTS.md');
    const claudeRulesAgents = path.join(fakeHome, '.claude/rules/AGENTS.md');
    assert.equal(existsSync(agyRulesAgents), false, 'Antigravity plugin must not have rules/AGENTS.md');
    assert.equal(existsSync(claudeRulesAgents), false, 'Claude Code rules must not have AGENTS.md');

    // 2. An unrigged repo (pure docs / non-coding project) has no worktree constraints
    gitCmd(unriggedRepo, 'init', '-q', '-b', 'main');
    gitCmd(unriggedRepo, 'config', 'user.email', 'test@example.com');
    gitCmd(unriggedRepo, 'config', 'user.name', 'Test');
    const docFile = path.join(unriggedRepo, 'notes.md');
    writeFileSync(docFile, '# Meeting Notes\n');

    // PreToolUse guard allows editing files in unrigged main checkout (returns null)
    const check = checkEditTarget(docFile, {
      cwd: unriggedRepo,
      homeDir: fakeHome,
    });
    assert.equal(check, null, 'checkEditTarget permits edits in unrigged repos');

    // Git commits directly on main in unrigged repo succeed without worktree restrictions
    gitCmd(unriggedRepo, 'add', 'notes.md');
    const commitRes = gitCmd(unriggedRepo, 'commit', '-m', 'docs: write meeting notes');
    assert.equal(commitRes.status, 0, commitRes.stderr);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(unriggedRepo, { recursive: true, force: true });
  }
});
