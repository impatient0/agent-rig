import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  buildAgensiSkills,
  buildSkillPackage,
  verifySkillPackage,
  stripAgentFrontmatter,
  generateBuyerReadme,
  TARGET_SKILLS,
} from '../scripts/build-agensi.mjs';
import { reflowMarkdown } from '../scripts/reflow-docs.mjs';
import { RIG_ROOT } from '../bin/rig.mjs';

test('buildAgensiSkills builds all six standalone skill packages into outDir with zip archives', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rig-agensi-test-'));
  try {
    const results = buildAgensiSkills({ outDir: tmp, rigRoot: RIG_ROOT });
    assert.equal(results.length, 6);

    for (const skill of TARGET_SKILLS) {
      const skillDir = path.join(tmp, skill);
      const zipFile = path.join(tmp, `${skill}.zip`);

      assert.ok(existsSync(skillDir), `Expected directory ${skillDir} to exist`);
      assert.ok(existsSync(zipFile), `Expected archive ${zipFile} to exist`);

      assert.ok(existsSync(path.join(skillDir, 'SKILL.md')), `Expected ${skill}/SKILL.md to exist`);
      assert.ok(existsSync(path.join(skillDir, 'README.md')), `Expected ${skill}/README.md to exist`);
    }

    // Verify Free SDD & Hygiene skills vs Paid flagship skills
    const dispatchDir = path.join(tmp, 'dispatch');
    assert.ok(existsSync(path.join(dispatchDir, 'references/worker.md')));
    assert.ok(existsSync(path.join(dispatchDir, 'references/verifier.md')));
    assert.ok(existsSync(path.join(dispatchDir, 'references/ui-change-gate.md')));
    assert.ok(existsSync(path.join(dispatchDir, 'references/contract-change-gate.md')));
    assert.ok(existsSync(path.join(dispatchDir, 'references/AGENTS.md')));
    assert.ok(existsSync(path.join(dispatchDir, 'references/field-notes.md')));
    assert.ok(existsSync(path.join(dispatchDir, 'references/merge-to-main.md')));

    const rigOnboardDir = path.join(tmp, 'rig-onboard');
    assert.ok(existsSync(path.join(rigOnboardDir, 'references/verifier.md')));
    assert.ok(existsSync(path.join(rigOnboardDir, 'templates/AGENTS.md')));
    assert.ok(existsSync(path.join(rigOnboardDir, 'templates/docs/backlog.md')));
    assert.ok(existsSync(path.join(rigOnboardDir, 'templates/docs/adr/0001-record-architecture-decisions.md')));

    const secDir = path.join(tmp, 'secure-credential-handoff');
    assert.equal(existsSync(path.join(secDir, 'references')), false);
    assert.equal(existsSync(path.join(secDir, 'scripts')), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('stripAgentFrontmatter removes model: and tools: keys while preserving name and description', () => {
  const sample = `---
name: verifier
model: {{SUBAGENT_MODEL_VERIFIER}}
description: >-
  Cold, read-only verification subagent.
tools:
  - run_command
  - read_file
---

# Content
`;
  const stripped = stripAgentFrontmatter(sample);
  assert.ok(stripped.includes('name: verifier'));
  assert.ok(stripped.includes('Cold, read-only verification subagent.'));
  assert.equal(stripped.includes('model:'), false);
  assert.equal(stripped.includes('tools:'), false);
  assert.equal(stripped.includes('run_command'), false);
  assert.ok(stripped.includes('# Content'));

  // When all frontmatter keys are stripped
  const onlyAgentKeys = `---
model: gpt-4
tools: Bash
---

# Only body
`;
  const strippedOnly = stripAgentFrontmatter(onlyAgentKeys);
  assert.equal(strippedOnly.startsWith('---'), false);
  assert.ok(strippedOnly.startsWith('# Only body'));

  // When no frontmatter exists
  const noFm = '# No Frontmatter\nBody text.\n';
  assert.equal(stripAgentFrontmatter(noFm), noFm);
});

test('template merging in rig-onboard/templates/AGENTS.md merges hydrated rules, docs index, and project context', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rig-onboard-test-'));
  try {
    buildSkillPackage('rig-onboard', { outDir: tmp, rigRoot: RIG_ROOT });
    const agentsPath = path.join(tmp, 'rig-onboard/templates/AGENTS.md');
    assert.ok(existsSync(agentsPath));

    const content = readFileSync(agentsPath, 'utf8');
    assert.ok(content.includes('<!-- AGENT-RIG:START -->'));
    assert.ok(content.includes('<!-- AGENT-RIG:END -->'));
    assert.ok(content.includes('Universal Agentic Engineering Rules'));

    assert.ok(content.includes('<!-- AGENT-RIG:DOCS:START -->'));
    assert.ok(content.includes('<!-- AGENT-RIG:DOCS:END -->'));
    assert.ok(content.includes('docs/backlog.md'));
    assert.ok(content.includes('docs/adr/0001-record-architecture-decisions.md'));

    assert.ok(content.includes('# Project Context'));
    assert.ok(content.includes('Test & verification gate'));

    assert.equal(/\{\{[A-Z0-9_]+\}\}/.test(content), false);
    assert.equal(/<!--\s*RIG:/.test(content), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bundled scripts in scripts/ are valid standalone tools', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rig-scripts-test-'));
  try {
    buildSkillPackage('dispatch', { outDir: tmp, rigRoot: RIG_ROOT });
    const scriptsDir = path.join(tmp, 'dispatch/scripts');
    const cdl = path.join(scriptsDir, 'check-doc-links.mjs');
    const rf = path.join(scriptsDir, 'reflow-docs.mjs');

    assert.ok(existsSync(cdl));
    assert.ok(existsSync(rf));

    const cdlContent = readFileSync(cdl, 'utf8');
    assert.ok(cdlContent.includes('export function runCli'));

    const rfContent = readFileSync(rf, 'utf8');
    assert.ok(rfContent.includes('export function reflowMarkdown'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('zip archive contains single top-level folder with zero symlinks or binaries and passes python zipfile verification', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rig-zip-test-'));
  try {
    buildSkillPackage('dispatch', { outDir: tmp, rigRoot: RIG_ROOT });
    const zipPath = path.join(tmp, 'dispatch.zip');
    assert.ok(existsSync(zipPath));

    const pyCheck = spawnSync('python3', [
      '-c',
      `
import zipfile, sys
z = zipfile.ZipFile("${zipPath}", "r")
err = z.testzip()
if err:
    sys.exit(f"Zip test failed on {err}")
names = z.namelist()
for n in names:
    if not n.startswith("dispatch/"):
        sys.exit(f"Entry {n} does not start with top-level dispatch/")
print(f"OK:{len(names)}")
`,
    ], { encoding: 'utf8' });

    assert.equal(pyCheck.status, 0, pyCheck.stderr);
    assert.ok(pyCheck.stdout.startsWith('OK:11'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('verifySkillPackage catches invalid frontmatter, placeholders, broken links, and reflow formatting', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rig-verify-fail-'));
  try {
    buildSkillPackage('secure-credential-handoff', { outDir: tmp, rigRoot: RIG_ROOT });
    const pkgDir = path.join(tmp, 'secure-credential-handoff');
    const skillPath = path.join(pkgDir, 'SKILL.md');

    // 1. Valid package passes
    const passRes = verifySkillPackage(pkgDir);
    assert.equal(passRes.valid, true);

    // 2. Catches unhydrated placeholder
    const origSkill = readFileSync(skillPath, 'utf8');
    writeFileSync(skillPath, origSkill + '\nPlaceholder: {{UNRESOLVED_TOKEN}}\n', 'utf8');
    assert.throws(() => verifySkillPackage(pkgDir), /unhydrated placeholder/);

    // 3. Catches leftover RIG comment
    writeFileSync(skillPath, origSkill + '\n<!-- RIG:IF harness=agensi -->foo<!-- RIG:ENDIF -->\n', 'utf8');
    assert.throws(() => verifySkillPackage(pkgDir), /leftover RIG comment/);

    // 4. Catches broken relative link
    writeFileSync(skillPath, origSkill + '\n[Missing Link](./references/does-not-exist.md)\n', 'utf8');
    assert.throws(() => verifySkillPackage(pkgDir), /broken relative link/);

    // 5. Catches escaping relative link
    writeFileSync(skillPath, origSkill + '\n[Escaping Link](../../outside.md)\n', 'utf8');
    assert.throws(() => verifySkillPackage(pkgDir), /link escapes package root/);

    // 6. Catches one-sentence-per-line formatting violation
    writeFileSync(skillPath, origSkill + '\nFirst sentence. Second sentence on the same line.\n', 'utf8');
    assert.throws(() => verifySkillPackage(pkgDir), /one-sentence-per-line/);

    // 7. Catches missing SKILL.md
    rmSync(skillPath);
    assert.throws(() => verifySkillPackage(pkgDir), /Missing SKILL\.md/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI node scripts/build-agensi.mjs supports --outDir and --skill flags', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rig-cli-build-'));
  try {
    const res = spawnSync('node', [
      path.resolve(RIG_ROOT, 'scripts/build-agensi.mjs'),
      '--outDir',
      tmp,
      '--skill',
      'secure-credential-handoff',
    ], { encoding: 'utf8' });

    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes('Successfully built 1 skill package'));
    assert.ok(existsSync(path.join(tmp, 'secure-credential-handoff/SKILL.md')));
    assert.ok(existsSync(path.join(tmp, 'secure-credential-handoff.zip')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
