import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const CORE_SKILLS = [
  'dispatch',
  'doc-audit',
  'backlog-audit',
  'wrap-up',
  'rig-onboard',
  'rig-update',
  'merge-to-main',
  'secure-credential-handoff',
];

test('all core SKILL.md files have valid frontmatter with name and trigger-rich descriptions', () => {
  for (const skill of CORE_SKILLS) {
    const skillPath = path.join(REPO_ROOT, 'skills', skill, 'SKILL.md');
    assert.ok(existsSync(skillPath), `SKILL.md missing for ${skill}`);
    const content = readFileSync(skillPath, 'utf8');

    // Frontmatter presence
    assert.ok(content.startsWith('---\n'), `${skill} missing opening frontmatter delimiter`);
    const endFm = content.indexOf('\n---\n', 4);
    assert.ok(endFm !== -1, `${skill} missing closing frontmatter delimiter`);
    const frontmatter = content.slice(4, endFm);

    // Name match
    assert.match(frontmatter, new RegExp(`^name:\\s*${skill}\\s*$`, 'm'), `${skill} frontmatter name mismatch`);

    // Trigger-rich description
    assert.match(frontmatter, /description:\s*(?:>-|>|\|)?\s*\n\s+/, `${skill} missing frontmatter description`);
    // Each skill must mention its slash command trigger
    assert.match(frontmatter, new RegExp(`/${skill}`), `${skill} description missing /${skill} trigger`);
  }
});

test('all core SKILL.md files define an explicit ## Output Format section with fenced templates', () => {
  for (const skill of CORE_SKILLS) {
    const skillPath = path.join(REPO_ROOT, 'skills', skill, 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');

    // Section header
    assert.match(content, /^## Output Format$/m, `${skill} missing ## Output Format section`);

    // Fenced markdown output template
    const outputFormatSection = content.slice(content.indexOf('## Output Format'));
    assert.match(
      outputFormatSection,
      /```markdown\n[\s\S]+?\n```/,
      `${skill} missing fenced markdown output template in ## Output Format`,
    );
  }
});

test('agents/verifier.md defines ## Required Output Format as canonical reference', () => {
  const verifierPath = path.join(REPO_ROOT, 'agents/verifier.md');
  assert.ok(existsSync(verifierPath));
  const content = readFileSync(verifierPath, 'utf8');
  assert.match(content, /^## Required Output Format$/m);
  assert.match(content, /```markdown\n## Verification Report[\s\S]+?\n```/);
});
