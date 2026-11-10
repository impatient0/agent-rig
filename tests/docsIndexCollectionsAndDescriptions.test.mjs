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
  parseDocFrontmatter,
  isCollectionDir,
  findCollectionDirs,
  buildDocsIndexBlock,
  buildCollectionDocsIndexBlock,
  updateDocManagedDocsBlock,
  updateRepo,
  runCheckDocs,
} from '../bin/rig.mjs';

const CHECKER = path.resolve(RIG_ROOT, 'scripts/check-doc-links.mjs');

function makeGitRepo(prefix = 'rig-col-test-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, git, cleanup };
}

test('parseDocFrontmatter correctly parses descriptions, booleans, and skips tags', () => {
  assert.deepEqual(parseDocFrontmatter(''), {});
  assert.deepEqual(parseDocFrontmatter('# Just a heading\n'), {});

  const fmBasic = `---
description: A straightforward single-sentence description.
collection: true
ephemeral: false
---

# Title
`;
  assert.deepEqual(parseDocFrontmatter(fmBasic), {
    description: 'A straightforward single-sentence description.',
    collection: true,
    ephemeral: false,
  });

  const fmQuoted = `---
description: "Special characters: colons and 'quotes'."
collection: true
tags:
  - doc
  - guide
---

# Title
`;
  const parsedQuoted = parseDocFrontmatter(fmQuoted);
  assert.equal(parsedQuoted.description, "Special characters: colons and 'quotes'.");
  assert.equal(parsedQuoted.collection, true);

  const fmFolded = `---
description: >-
  Folded description that spans
  across multiple lines.
collection: true
---

# Title
`;
  const parsedFolded = parseDocFrontmatter(fmFolded);
  assert.equal(parsedFolded.description, 'Folded description that spans across multiple lines.');
  assert.equal(parsedFolded.collection, true);
});

test('buildDocsIndexBlock appends frontmatter description and handles ADR status tags', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'build-docs-desc-'));
  try {
    mkdirSync(path.join(dir, 'docs', 'adr'), { recursive: true });

    writeFileSync(
      path.join(dir, 'docs', 'backlog.md'),
      '# Backlog\n',
    );
    writeFileSync(
      path.join(dir, 'docs', 'overview.md'),
      '---\ndescription: System architecture overview.\n---\n\n# Overview\n',
    );
    writeFileSync(
      path.join(dir, 'docs', 'adr', '0001-setup.md'),
      '---\ndescription: Initial repository scaffolding.\n---\n\n# ADR 0001: Setup\n\n## Status\n\nSuperseded by ADR 0002.\n',
    );
    writeFileSync(
      path.join(dir, 'docs', 'adr', '0002-migrate.md'),
      '# ADR 0002: Migrate\n\n## Status\n\nAccepted.\n',
    );

    const block = buildDocsIndexBlock(dir);
    assert.ok(block.includes('- [`docs/backlog.md`](docs/backlog.md) — Backlog'));
    assert.ok(block.includes('- [`docs/overview.md`](docs/overview.md) — Overview — System architecture overview.'));
    assert.ok(
      block.includes(
        '- [`docs/adr/0001-setup.md`](docs/adr/0001-setup.md) — ADR 0001: Setup (Superseded by ADR 0002) — Initial repository scaffolding.',
      ),
    );
    assert.ok(block.includes('- [`docs/adr/0002-migrate.md`](docs/adr/0002-migrate.md) — ADR 0002: Migrate'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subdirectory collections emit single entry in parent index and index their own members', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'build-docs-col-'));
  try {
    mkdirSync(path.join(dir, 'docs', 'guides'), { recursive: true });

    writeFileSync(path.join(dir, 'docs', 'backlog.md'), '# Backlog\n');
    writeFileSync(
      path.join(dir, 'docs', 'guides', 'README.md'),
      '---\ncollection: true\ndescription: Operator and developer guides.\n---\n\n# Guides\n',
    );
    writeFileSync(
      path.join(dir, 'docs', 'guides', 'quickstart.md'),
      '---\ndescription: Getting started in 5 minutes.\n---\n\n# Quickstart\n',
    );
    writeFileSync(
      path.join(dir, 'docs', 'guides', 'deploy.md'),
      '# Deployment\n',
    );

    assert.equal(isCollectionDir(path.join(dir, 'docs', 'guides')), true);
    assert.equal(isCollectionDir(path.join(dir, 'docs')), false);

    const rootBlock = buildDocsIndexBlock(dir);
    assert.ok(rootBlock.includes('- [`docs/backlog.md`](docs/backlog.md) — Backlog'));
    assert.ok(rootBlock.includes('- [`docs/guides/README.md`](docs/guides/README.md) — Guides — Operator and developer guides.'));
    // Child files of guides must NOT appear in the parent index
    assert.equal(rootBlock.includes('quickstart.md'), false);
    assert.equal(rootBlock.includes('deploy.md'), false);

    const colBlock = buildCollectionDocsIndexBlock(path.join(dir, 'docs', 'guides'), dir);
    assert.ok(colBlock.includes(MANAGED_DOCS_START));
    assert.ok(colBlock.includes(MANAGED_DOCS_END));
    assert.ok(colBlock.includes('- [`deploy.md`](deploy.md) — Deployment'));
    assert.ok(colBlock.includes('- [`quickstart.md`](quickstart.md) — Quickstart — Getting started in 5 minutes.'));
    // README.md of the collection itself must NOT appear in its own index
    assert.equal(colBlock.includes('README.md'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nested collections maintain hierarchical indexes across multiple levels', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nested-col-'));
  try {
    mkdirSync(path.join(dir, 'docs', 'platform', 'advanced'), { recursive: true });

    writeFileSync(path.join(dir, 'docs', 'backlog.md'), '# Backlog\n');
    writeFileSync(
      path.join(dir, 'docs', 'platform', 'README.md'),
      '---\ncollection: true\ndescription: Platform architecture and guides.\n---\n\n# Platform\n',
    );
    writeFileSync(
      path.join(dir, 'docs', 'platform', 'intro.md'),
      '---\ndescription: Platform overview.\n---\n\n# Intro\n',
    );
    writeFileSync(
      path.join(dir, 'docs', 'platform', 'advanced', 'README.md'),
      '---\ncollection: true\ndescription: Advanced tuning and internals.\n---\n\n# Advanced\n',
    );
    writeFileSync(
      path.join(dir, 'docs', 'platform', 'advanced', 'tuning.md'),
      '---\ndescription: Kernel and GC tuning.\n---\n\n# Tuning\n',
    );

    const colDirs = findCollectionDirs(path.join(dir, 'docs'));
    assert.equal(colDirs.length, 2);

    // Root index only references top-level collection platform/README.md
    const rootBlock = buildDocsIndexBlock(dir);
    assert.ok(rootBlock.includes('- [`docs/platform/README.md`](docs/platform/README.md) — Platform — Platform architecture and guides.'));
    assert.equal(rootBlock.includes('intro.md'), false);
    assert.equal(rootBlock.includes('advanced/README.md'), false);
    assert.equal(rootBlock.includes('tuning.md'), false);

    // Platform collection references intro.md and advanced/README.md
    const platformBlock = buildCollectionDocsIndexBlock(path.join(dir, 'docs', 'platform'), dir);
    assert.ok(platformBlock.includes('- [`intro.md`](intro.md) — Intro — Platform overview.'));
    assert.ok(platformBlock.includes('- [`advanced/README.md`](advanced/README.md) — Advanced — Advanced tuning and internals.'));
    assert.equal(platformBlock.includes('tuning.md'), false);

    // Advanced collection references tuning.md
    const advancedBlock = buildCollectionDocsIndexBlock(path.join(dir, 'docs', 'platform', 'advanced'), dir);
    assert.ok(advancedBlock.includes('- [`tuning.md`](tuning.md) — Tuning — Kernel and GC tuning.'));
    assert.equal(advancedBlock.includes('advanced/README.md'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-doc-links validates collection indexes and --fix updates them with BFS reachability', () => {
  const { dir, git, cleanup } = makeGitRepo('check-docs-col-');
  try {
    mkdirSync(path.join(dir, '.rig'), { recursive: true });
    mkdirSync(path.join(dir, 'docs', 'guides'), { recursive: true });

    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '<!-- AGENT-RIG:START -->\nRules\n<!-- AGENT-RIG:END -->\n\n# Project Context\n',
    );
    writeFileSync(path.join(dir, 'docs', 'backlog.md'), '# Backlog\n');
    writeFileSync(
      path.join(dir, 'docs', 'guides', 'README.md'),
      '---\ncollection: true\ndescription: Operator guides.\n---\n\n# Guides\n',
    );
    writeFileSync(
      path.join(dir, 'docs', 'guides', 'setup.md'),
      '---\ndescription: Setup instructions.\n---\n\n# Setup\n',
    );

    // Without --fix, missing index in AGENTS.md and collection README.md fails
    const fail = runCheckDocs(dir);
    assert.notEqual(fail.status, 0);
    assert.match(fail.stderr, /documentation index is missing or out of date/);

    // With --fix, both AGENTS.md and collection README.md are updated
    const fixRes = runCheckDocs(dir, { fix: true });
    assert.equal(fixRes.status, 0, fixRes.stderr);

    const updatedAgents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(updatedAgents.includes('- [`docs/guides/README.md`](docs/guides/README.md) — Guides — Operator guides.'));
    assert.equal(updatedAgents.includes('setup.md'), false);

    const updatedReadme = readFileSync(path.join(dir, 'docs', 'guides', 'README.md'), 'utf8');
    assert.ok(updatedReadme.includes(MANAGED_DOCS_START));
    assert.ok(updatedReadme.includes('- [`setup.md`](setup.md) — Setup — Setup instructions.'));

    // Re-running check-docs passes cleanly with full BFS reachability
    const pass = runCheckDocs(dir);
    assert.equal(pass.status, 0, pass.stderr);
  } finally {
    cleanup();
  }
});

test('updateRepo updates collection documentation indexes on rig update', () => {
  const { dir, git, cleanup } = makeGitRepo('update-col-');
  try {
    mkdirSync(path.join(dir, '.rig', 'hooks'), { recursive: true });
    mkdirSync(path.join(dir, 'docs', 'manual'), { recursive: true });

    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '<!-- AGENT-RIG:START -->\nRules\n<!-- AGENT-RIG:END -->\n\n# Project Context\n',
    );
    writeFileSync(path.join(dir, 'docs', 'backlog.md'), '# Backlog\n');
    writeFileSync(
      path.join(dir, 'docs', 'manual', 'README.md'),
      '---\ncollection: true\ndescription: Manual.\n---\n\n# Manual\n',
    );
    writeFileSync(
      path.join(dir, 'docs', 'manual', 'run.md'),
      '# Run\n',
    );

    const res = updateRepo(dir, { rigRoot: RIG_ROOT });
    const updatedCol = readFileSync(path.join(dir, 'docs', 'manual', 'README.md'), 'utf8');
    assert.ok(updatedCol.includes(MANAGED_DOCS_START));
    assert.ok(updatedCol.includes('- [`run.md`](run.md) — Run'));
  } finally {
    cleanup();
  }
});
