import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHECKER = path.resolve(import.meta.dirname, '../scripts/check-doc-links.mjs');

test('the agent-rig baseline corpus passes check-doc-links', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const res = spawnSync(process.execPath, [CHECKER, repoRoot], { encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
});

test('check-doc-links can target an arbitrary external directory and catches broken links and orphans', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rig-doclinks-'));
  try {
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    writeFileSync(path.join(dir, 'README.md'), '# App\n\nSee [AGENTS.md](AGENTS.md).\n'); // check-doc-links:ignore
    writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n\nSee [missing](docs/missing.md).\n'); // check-doc-links:ignore
    writeFileSync(path.join(dir, 'docs/orphan.md'), '# Orphan\n'); // check-doc-links:ignore

    const fail = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
    assert.notEqual(fail.status, 0);
    assert.match(fail.stderr, /broken link/);
    assert.match(fail.stderr, /orphan/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-doc-links permits code symbols on tracked paths and rejects missing paths and extensions', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rig-symbols-'));
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    mkdirSync(path.join(dir, 'internal', 'firewall'), { recursive: true });
    writeFileSync(path.join(dir, 'internal', 'firewall', 'firewall.go'), 'package firewall\ntype Engine struct{}\n');
    writeFileSync(path.join(dir, 'README.md'), '# App\n\nSee [AGENTS.md](AGENTS.md).\n');
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# Agents\n\nInvariant: `internal/firewall.Engine` is primary.\n',
    );
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'initial');

    // Valid symbol on existing tracked directory passes
    const ok = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);

    // Missing package fails
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# Agents\n\nInvariant: `internal/missing.Engine` is primary.\n',
    );
    git(dir, 'add', 'AGENTS.md');
    git(dir, 'commit', '-qm', 'bad symbol');
    const badPkg = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
    assert.notEqual(badPkg.status, 0);
    assert.match(badPkg.stderr, /internal\/missing\.Engine does not exist/);

    // Common file extension on directory is not excused as a symbol
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# Agents\n\nFile: `internal/firewall.go` is primary.\n',
    );
    git(dir, 'add', 'AGENTS.md');
    git(dir, 'commit', '-qm', 'bad extension');
    const badExt = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
    assert.notEqual(badExt.status, 0);
    assert.match(badExt.stderr, /internal\/firewall\.go does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-doc-links parses double-backtick inline code spans without spurious errors', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rig-double-backticks-'));
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'scripts', 'run.mjs'), 'console.log("ok");\n');
    writeFileSync(path.join(dir, 'README.md'), '# App\n\nSee [AGENTS.md](AGENTS.md).\n');
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# Agents\n\n' +
        'Config ``<git-common-dir>/rig-briefs/<slug>.md`` is valid.\n' +
        'Nested `` `inner` `` and `scripts/run.mjs` both parse.\n' +
        'Tracked path in double backticks: ``scripts/run.mjs`` works.\n',
    );
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'initial');

    // Valid double-backtick code spans and subsequent paths parse without errors
    const ok = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);

    // Missing path inside double backticks is caught
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# Agents\n\nMissing path: ``scripts/missing.mjs`` fails.\n',
    );
    git(dir, 'add', 'AGENTS.md');
    git(dir, 'commit', '-qm', 'bad double backtick path');
    const badDouble = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
    assert.notEqual(badDouble.status, 0);
    assert.match(badDouble.stderr, /scripts\/missing\.mjs does not exist/);

    // Desynchronization test: nested backticks do not hide missing path on same line
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# Agents\n\nInvariant: `` `cmd` `` and `scripts/missing.mjs` are checked.\n',
    );
    git(dir, 'add', 'AGENTS.md');
    git(dir, 'commit', '-qm', 'bad subsequent path');
    const badSubsequent = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
    assert.notEqual(badSubsequent.status, 0);
    assert.match(badSubsequent.stderr, /scripts\/missing\.mjs does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-doc-links is 100% standalone and executes when copied to an isolated directory without bin/rig.mjs', () => {
  const isolatedDir = mkdtempSync(path.join(tmpdir(), 'rig-standalone-checker-'));
  const testRepoDir = mkdtempSync(path.join(tmpdir(), 'rig-standalone-repo-'));
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  try {
    // Copy check-doc-links.mjs into an isolated directory with NO bin/rig.mjs
    const isolatedChecker = path.join(isolatedDir, 'check-doc-links.mjs');
    copyFileSync(CHECKER, isolatedChecker);

    // Verify static invariants: imports ONLY node: built-ins, zero relative imports
    const checkerSource = readFileSync(isolatedChecker, 'utf8');
    const importLines = checkerSource.split('\n').filter((l) => /^\s*import\b/.test(l));
    assert.ok(importLines.length > 0, 'must have import lines');
    for (const imp of importLines) {
      assert.match(imp, /from\s+['"]node:[^'"]+['"]/, `non-builtin import found: ${imp}`);
      assert.doesNotMatch(imp, /bin\/rig\.mjs/);
      assert.doesNotMatch(imp, /\.\.\//);
    }

    // Set up a clean git repo
    git(testRepoDir, 'init', '-q', '-b', 'main');
    git(testRepoDir, 'config', 'user.email', 'test@example.com');
    git(testRepoDir, 'config', 'user.name', 'Test');
    mkdirSync(path.join(testRepoDir, 'docs'), { recursive: true });
    writeFileSync(path.join(testRepoDir, 'README.md'), '# App\n\nSee [AGENTS.md](AGENTS.md).\n');
    writeFileSync(
      path.join(testRepoDir, 'AGENTS.md'),
      '# Agents\n\n<!-- AGENT-RIG:START -->\nRules\n<!-- AGENT-RIG:END -->\n\n' +
        '<!-- AGENT-RIG:DOCS:START -->\n<!-- AGENT-RIG:DOCS:END -->\n\n# Context\n',
    );
    writeFileSync(path.join(testRepoDir, 'docs', 'guide.md'), '# Guide\n\nUseful guide.\n');
    git(testRepoDir, 'add', '-A');
    git(testRepoDir, 'commit', '-qm', 'initial');

    // Run check-doc-links with --fix from the isolated checker script
    const fixRes = spawnSync(process.execPath, [isolatedChecker, testRepoDir, '--fix'], { encoding: 'utf8' });
    assert.equal(fixRes.status, 0, `${fixRes.stdout}${fixRes.stderr}`);
    assert.match(fixRes.stdout, /updated documentation index in AGENTS\.md/);

    // Confirm AGENTS.md now contains the generated docs index
    const updatedAgents = readFileSync(path.join(testRepoDir, 'AGENTS.md'), 'utf8');
    assert.match(updatedAgents, /docs\/guide\.md/);

    // Run isolated checker again without --fix, should pass cleanly
    git(testRepoDir, 'add', 'AGENTS.md');
    git(testRepoDir, 'commit', '-qm', 'update index');
    const checkRes = spawnSync(process.execPath, [isolatedChecker, testRepoDir], { encoding: 'utf8' });
    assert.equal(checkRes.status, 0, `${checkRes.stdout}${checkRes.stderr}`);
    assert.match(checkRes.stdout, /all internal links resolve\. OK\./);

    // Corrupt a link and ensure isolated checker detects the error
    writeFileSync(path.join(testRepoDir, 'docs', 'guide.md'), '# Guide\n\nSee [missing](docs/nonexistent.md).\n'); // check-doc-links:ignore
    git(testRepoDir, 'add', 'docs/guide.md');
    git(testRepoDir, 'commit', '-qm', 'broken link');
    const failRes = spawnSync(process.execPath, [isolatedChecker, testRepoDir], { encoding: 'utf8' });
    assert.notEqual(failRes.status, 0);
    assert.match(failRes.stderr, /broken link/);
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
    rmSync(testRepoDir, { recursive: true, force: true });
  }
});

test('pure Markdown string helpers can be imported directly from scripts/check-doc-links.mjs without side effects', async () => {
  const mod = await import('../scripts/check-doc-links.mjs');
  const rigMod = await import('../bin/rig.mjs');

  // Verify all expected helpers and constants are exported
  assert.equal(typeof mod.buildDocsIndexBlock, 'function');
  assert.equal(typeof mod.extractManagedDocsBlock, 'function');
  assert.equal(typeof mod.extractManagedAgentsBlock, 'function');
  assert.equal(typeof mod.mergeManagedAgentsFile, 'function');
  assert.equal(typeof mod.parseAdrStatus, 'function');
  assert.equal(typeof mod.isEphemeralDoc, 'function');
  assert.equal(typeof mod.MANAGED_AGENTS_START, 'string');
  assert.equal(typeof mod.MANAGED_DOCS_START, 'string');

  // Verify re-exported helpers in bin/rig.mjs are identical references
  assert.strictEqual(mod.buildDocsIndexBlock, rigMod.buildDocsIndexBlock);
  assert.strictEqual(mod.extractManagedDocsBlock, rigMod.extractManagedDocsBlock);
  assert.strictEqual(mod.extractManagedAgentsBlock, rigMod.extractManagedAgentsBlock);
  assert.strictEqual(mod.mergeManagedAgentsFile, rigMod.mergeManagedAgentsFile);
  assert.strictEqual(mod.parseAdrStatus, rigMod.parseAdrStatus);
  assert.strictEqual(mod.isEphemeralDoc, rigMod.isEphemeralDoc);
  assert.strictEqual(mod.MANAGED_AGENTS_START, rigMod.MANAGED_AGENTS_START);
  assert.strictEqual(mod.MANAGED_DOCS_START, rigMod.MANAGED_DOCS_START);

  // Test functional execution of extracted pure helper
  const testContent = '<!-- AGENT-RIG:START -->\nrules\n<!-- AGENT-RIG:END -->\nuser context';
  const { hasBlock, block } = mod.extractManagedAgentsBlock(testContent);
  assert.equal(hasBlock, true);
  assert.match(block, /rules/);
});

