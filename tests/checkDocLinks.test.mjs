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
