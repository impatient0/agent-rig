import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RIG_ROOT,
  MANAGED_DOCS_START,
  MANAGED_DOCS_END,
  parseAdrStatus,
  isEphemeralDoc,
  buildDocsIndexBlock,
  extractManagedDocsBlock,
  mergeManagedAgentsFile,
  initRepo,
  updateRepo,
  runPreCommitHook,
  runCheckDocs,
  installRig,
} from '../bin/rig.mjs';
import { checkEditTarget } from '../hooks/guard-main-checkout-edits.mjs';

const CHECKER = path.resolve(RIG_ROOT, 'scripts/check-doc-links.mjs');

function makeGitRepo(prefix = 'rig-docs-test-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, git, cleanup };
}

test('parseAdrStatus extracts titles and tags correctly across status variants', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adr-status-'));
  try {
    const f1 = path.join(dir, '0001.md');
    writeFileSync(f1, '# ADR 0001: First Decision\n\n## Status\n\nAccepted.\n');
    assert.deepEqual(parseAdrStatus(f1), {
      title: 'ADR 0001: First Decision',
      rawStatus: 'Accepted.',
      statusTag: null,
    });

    const f2 = path.join(dir, '0002.md');
    writeFileSync(f2, '# ADR 0002: Second Decision\n\n## Status\n\nSuperseded by ADR 0003.\n');
    assert.deepEqual(parseAdrStatus(f2), {
      title: 'ADR 0002: Second Decision',
      rawStatus: 'Superseded by ADR 0003.',
      statusTag: 'Superseded by ADR 0003',
    });

    const f3 = path.join(dir, '0003.md');
    writeFileSync(f3, '# ADR 0003: Linked Superseded\n\n## Status\n\nSuperseded by [ADR 0004](0004-next.md).\n');
    assert.deepEqual(parseAdrStatus(f3), {
      title: 'ADR 0003: Linked Superseded',
      rawStatus: 'Superseded by [ADR 0004](0004-next.md).',
      statusTag: 'Superseded by ADR 0004',
    });

    const f4 = path.join(dir, '0004.md');
    writeFileSync(f4, '# ADR 0004: Deprecated Feature\n\n## Status\n\nDeprecated.\n');
    assert.deepEqual(parseAdrStatus(f4), {
      title: 'ADR 0004: Deprecated Feature',
      rawStatus: 'Deprecated.',
      statusTag: 'Deprecated',
    });

    const f5 = path.join(dir, '0005.md');
    writeFileSync(f5, '# ADR 0005: Proposed RFC\n\n## Status\n\nProposed.\n');
    assert.deepEqual(parseAdrStatus(f5), {
      title: 'ADR 0005: Proposed RFC',
      rawStatus: 'Proposed.',
      statusTag: 'Proposed',
    });

    const fMissing = path.join(dir, 'missing.md');
    assert.equal(parseAdrStatus(fMissing), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isEphemeralDoc recognizes ephemeral paths and markers', () => {
  assert.equal(isEphemeralDoc('docs/epics/epic-1.md', '# Epic 1\n'), true); // check-doc-links:ignore
  assert.equal(isEphemeralDoc('docs/design/mockup.md', '---\nephemeral: true\n---\n# Mockup\n'), true); // check-doc-links:ignore
  assert.equal(isEphemeralDoc('docs/temp.md', '<!-- ephemeral -->\n# Temp\n'), true); // check-doc-links:ignore
  assert.equal(isEphemeralDoc('docs/cleanup.md', '# Cleanup\nDelete this file when slice 3 is merged.\n'), true); // check-doc-links:ignore
  assert.equal(isEphemeralDoc('docs/backlog.md', '# Backlog\n'), false);
  assert.equal(isEphemeralDoc('docs/adr/0001-init.md', '# ADR 0001\n'), false); // check-doc-links:ignore
});

test('buildDocsIndexBlock scans docs and adrs and formats documentation index', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'build-docs-index-'));
  try {
    assert.equal(buildDocsIndexBlock(dir), '');

    mkdirSync(path.join(dir, 'docs', 'adr'), { recursive: true });
    mkdirSync(path.join(dir, 'docs', 'epics'), { recursive: true });

    writeFileSync(path.join(dir, 'docs', 'backlog.md'), '# Backlog\n');
    writeFileSync(path.join(dir, 'docs', 'field-notes.md'), '# Field Notes\n');
    writeFileSync(path.join(dir, 'docs', 'epics', 'epic-1.md'), '# Epic 1\nDelete this file when done.\n');
    writeFileSync(
      path.join(dir, 'docs', 'adr', '0001-setup.md'),
      '# ADR 0001: Setup\n\n## Status\n\nSuperseded by ADR 0002.\n',
    );
    writeFileSync(path.join(dir, 'docs', 'adr', '0002-migrate.md'), '# ADR 0002: Migrate\n\n## Status\n\nAccepted.\n');

    const block = buildDocsIndexBlock(dir);
    assert.ok(block.includes(MANAGED_DOCS_START));
    assert.ok(block.includes(MANAGED_DOCS_END));
    assert.ok(block.includes('## Documentation Index'));
    assert.ok(block.includes('- [`docs/backlog.md`](docs/backlog.md) — Backlog'));
    assert.ok(block.includes('- [`docs/field-notes.md`](docs/field-notes.md) — Field Notes'));
    assert.ok(block.includes('- [`docs/adr/0001-setup.md`](docs/adr/0001-setup.md) — ADR 0001: Setup (Superseded by ADR 0002)'));
    assert.ok(block.includes('- [`docs/adr/0002-migrate.md`](docs/adr/0002-migrate.md) — ADR 0002: Migrate'));
    assert.equal(block.includes('docs/epics/epic-1.md'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeManagedAgentsFile merges rules, docs index, and user project context in canonical order', () => {
  const rules = '<!-- AGENT-RIG:START -->\nRules\n<!-- AGENT-RIG:END -->';
  const docs = '<!-- AGENT-RIG:DOCS:START -->\nDocs Index\n<!-- AGENT-RIG:DOCS:END -->';
  const ctx = '# Project Context\n\nCustom user context.';

  // Fresh merge
  const fresh = mergeManagedAgentsFile('', rules, ctx, docs);
  assert.equal(fresh, `${rules}\n\n${docs}\n\n${ctx}\n`);

  // Update both blocks while preserving user context
  const newRules = '<!-- AGENT-RIG:START -->\nUpdated Rules\n<!-- AGENT-RIG:END -->';
  const newDocs = '<!-- AGENT-RIG:DOCS:START -->\nUpdated Docs Index\n<!-- AGENT-RIG:DOCS:END -->';
  const updated = mergeManagedAgentsFile(fresh, newRules, '', newDocs);
  assert.equal(updated, `${newRules}\n\n${newDocs}\n\n${ctx}\n`);

  // Omitting docsIndexBlock preserves existing docs block
  const preserved = mergeManagedAgentsFile(updated, rules);
  assert.equal(preserved, `${rules}\n\n${newDocs}\n\n${ctx}\n`);

  // Passing empty string removes docs block
  const removed = mergeManagedAgentsFile(updated, rules, '', '');
  assert.equal(removed, `${rules}\n\n${ctx}\n`);
});

test('initRepo scaffolds AGENTS.md with documentation index and does not scaffold README.md', () => {
  const { dir, git, cleanup } = makeGitRepo('init-docs-index-');
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'init-docs-home-'));
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    installRig({ homeDir: fakeHome, harnesses: ['antigravity'], rigRoot: RIG_ROOT });

    initRepo(dir, { selfContained: false, homeDir: fakeHome, rigRoot: RIG_ROOT, worktrees: false });

    // Verify README.md is NOT scaffolded
    assert.equal(existsSync(path.join(dir, 'README.md')), false);

    // Verify AGENTS.md contains both managed blocks
    const agentsText = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    const { hasBlock: hasRules } = extractManagedDocsBlock(agentsText);
    const { hasBlock: hasDocs, block: docsBlock } = extractManagedDocsBlock(agentsText);
    assert.ok(hasDocs);
    assert.ok(docsBlock.includes('docs/backlog.md'));
    assert.ok(docsBlock.includes('docs/adr/0001-record-architecture-decisions.md'));
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('guard-main-checkout-edits rejects edits inside AGENT-RIG:DOCS block', () => {
  const { dir, git, cleanup } = makeGitRepo('guard-docs-block-');
  try {
    mkdirSync(path.join(dir, '.rig/hooks'), { recursive: true });
    writeFileSync(path.join(dir, '.rig/hooks/pre-commit'), '#!/bin/sh\n');

    const agentsContent =
      '<!-- AGENT-RIG:START -->\nRules\n<!-- AGENT-RIG:END -->\n\n' +
      '<!-- AGENT-RIG:DOCS:START -->\n## Documentation Index\n- [`docs/backlog.md`](docs/backlog.md)\n<!-- AGENT-RIG:DOCS:END -->\n\n' +
      '# Project Context\n\nUser context.\n';
    writeFileSync(path.join(dir, 'AGENTS.md'), agentsContent, 'utf8');

    // Edit targeting inside docs block is blocked
    const denyEdit = checkEditTarget('AGENTS.md', {
      cwd: dir,
      toolArgs: { Target: '- [`docs/backlog.md`](docs/backlog.md)' },
    });
    assert.match(denyEdit, /AGENT-RIG:DOCS:START/);

    // Edit targeting user context is allowed
    const allowEdit = checkEditTarget('AGENTS.md', {
      cwd: dir,
      toolArgs: { Target: 'User context.' },
    });
    assert.equal(allowEdit, null);
  } finally {
    cleanup();
  }
});

test('pre-commit hook refuses modified AGENT-RIG:DOCS block unless matching canonical buildDocsIndexBlock', () => {
  const { dir, git, cleanup } = makeGitRepo('pre-commit-docs-');
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'precommit-docs-home-'));
  try {
    mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
    installRig({ homeDir: fakeHome, harnesses: ['antigravity'], rigRoot: RIG_ROOT });

    initRepo(dir, { selfContained: false, homeDir: fakeHome, rigRoot: RIG_ROOT, worktrees: false });

    // Initial commit
    git('add', '-A');
    const initRes = runPreCommitHook(dir);
    assert.equal(initRes.status, 0);
    git('commit', '-m', 'chore: initial');

    // Tamper with AGENTS.md documentation index manually
    const agentsPath = path.join(dir, 'AGENTS.md');
    const currentAgents = readFileSync(agentsPath, 'utf8');
    const tampered = currentAgents.replace(
      '<!-- AGENT-RIG:DOCS:START -->',
      '<!-- AGENT-RIG:DOCS:START -->\n- [tampered](tampered.md)',
    );
    writeFileSync(agentsPath, tampered, 'utf8');
    git('add', 'AGENTS.md');

    // Pre-commit must reject tampered documentation index
    const rejectRes = runPreCommitHook(dir);
    assert.equal(rejectRes.status, 1);
    assert.match(rejectRes.stderr, /modified agent-rig documentation index in AGENTS.md/);

    // Adding a real ADR and updating via updateRepo makes pre-commit succeed
    writeFileSync(
      path.join(dir, 'docs/adr/0002-another.md'),
      '# ADR 0002: Another Decision\n\n## Status\n\nAccepted.\n',
    );
    const expected = buildDocsIndexBlock(dir);
    const validUpdate = mergeManagedAgentsFile(currentAgents, undefined, '', expected);
    writeFileSync(agentsPath, validUpdate, 'utf8');
    git('add', 'AGENTS.md', 'docs/adr/0002-another.md');

    const passRes = runPreCommitHook(dir);
    assert.equal(passRes.status, 0);
  } finally {
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('check-doc-links treats doc linked only from README as orphan and passes when linked from AGENTS.md', () => {
  const { dir, git, cleanup } = makeGitRepo('orphan-readme-');
  try {
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    writeFileSync(path.join(dir, 'README.md'), '# Readme\n\nSee [docs/feature.md](docs/feature.md).\n'); // check-doc-links:ignore
    writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
    writeFileSync(path.join(dir, 'docs/feature.md'), '# Feature\n'); // check-doc-links:ignore

    // Not reachable from AGENTS.md, only README.md -> orphan!
    const fail = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
    assert.notEqual(fail.status, 0);
    assert.match(fail.stderr, /docs\/feature\.md: orphan — not reachable from AGENTS\.md/);

    // Link from AGENTS.md -> passes!
    writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n\nSee [docs/feature.md](docs/feature.md).\n'); // check-doc-links:ignore
    const ok = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    cleanup();
  }
});

test('check-doc-links --fix updates AGENTS.md documentation index automatically', () => {
  const { dir, git, cleanup } = makeGitRepo('check-docs-fix-');
  try {
    mkdirSync(path.join(dir, '.rig'), { recursive: true });
    mkdirSync(path.join(dir, 'docs', 'adr'), { recursive: true });
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '<!-- AGENT-RIG:START -->\nRules\n<!-- AGENT-RIG:END -->\n\n# Project Context\n',
    );
    writeFileSync(path.join(dir, 'docs', 'backlog.md'), '# Backlog\n');
    writeFileSync(
      path.join(dir, 'docs', 'adr', '0001-init.md'), // check-doc-links:ignore
      '# ADR 0001: Initial\n\n## Status\n\nAccepted.\n',
    );

    // Running check-doc-links without --fix reports error
    const fail = runCheckDocs(dir);
    assert.notEqual(fail.status, 0);
    assert.match(fail.stderr, /documentation index is missing or out of date/);

    // Running check-doc-links with --fix updates AGENTS.md
    const fixed = runCheckDocs(dir, { fix: true });
    assert.equal(fixed.status, 0, fixed.stderr);

    const updatedText = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(updatedText.includes(MANAGED_DOCS_START));
    assert.ok(updatedText.includes('docs/adr/0001-init.md'));
  } finally {
    cleanup();
  }
});
