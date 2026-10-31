import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
