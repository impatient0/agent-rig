#!/usr/bin/env node
/**
 * Standalone skill package bundler for the Agensi marketplace.
 *
 * Builds six standalone skill packages into <outDir>/<slug>/ and <outDir>/<slug>.zip:
 *   - Five Free SDD & Hygiene skills: rig-onboard, doc-audit, backlog-audit, wrap-up, secure-credential-handoff
 *   - One Paid Autonomous Execution flagship: dispatch (excluding CLI-only rig-update)
 *
 * Governed by docs/adr/0003-conditional-markdown-hydration-and-marketplace-bundling.md.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { pathToFileURL } from 'node:url';

import {
  hydrateText,
  resolveProfile,
  AGENSI_PROFILE,
  RIG_ROOT,
  MANAGED_AGENTS_START,
  MANAGED_AGENTS_END,
  MANAGED_AGENTS_HEADER,
} from '../bin/rig.mjs';
import { reflowMarkdown } from './reflow-docs.mjs';
import {
  parseDocFrontmatter,
  mergeManagedAgentsFile,
  buildDocsIndexBlock,
} from './check-doc-links.mjs';

export const TARGET_SKILLS = [
  'rig-onboard',
  'doc-audit',
  'backlog-audit',
  'wrap-up',
  'secure-credential-handoff',
  'dispatch',
];

export { AGENSI_PROFILE };

/**
 * Strips agent-only `model:` and `tools:` YAML frontmatter keys from files placed in references/.
 */
export function stripAgentFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return content;
  const rawYaml = match[1];
  const body = match[2];

  const yamlLines = rawYaml.split(/\r?\n/);
  const filteredLines = [];
  let skippingKey = null;

  for (const line of yamlLines) {
    if (skippingKey) {
      if (/^\s+/.test(line)) {
        continue;
      } else {
        skippingKey = null;
      }
    }
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):/);
    if (keyMatch) {
      const key = keyMatch[1];
      if (key === 'model' || key === 'tools') {
        skippingKey = key;
        continue;
      }
    }
    filteredLines.push(line);
  }

  const remainingYaml = filteredLines.join('\n').trim();
  if (!remainingYaml) {
    return body.trimStart();
  }
  return `---\n${remainingYaml}\n---\n\n${body.trimStart()}`;
}

/**
 * Creates a valid PKZIP archive buffer in pure JS using node:zlib.
 * Ensures single top-level folder <topDirName>/, zero symlinks, zero hidden files.
 */
export function createZipBuffer(entries, topDirName) {
  const localChunks = [];
  const cdChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const zipPath = `${topDirName}/${entry.path}`.replace(/\\/g, '/');
    const nameBuf = Buffer.from(zipPath, 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = deflateRawSync(dataBuf);
    const crc = crc32(dataBuf);

    // Local file header (30 bytes)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuf, compressed);

    // Central directory file header (46 bytes)
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0x0800, 8); // UTF-8
    cdHeader.writeUInt16LE(8, 10); // deflate
    cdHeader.writeUInt16LE(0, 12);
    cdHeader.writeUInt16LE(0, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(compressed.length, 20);
    cdHeader.writeUInt32LE(dataBuf.length, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
    cdHeader.writeUInt32LE(offset, 42);

    cdChunks.push(cdHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const cdBuf = Buffer.concat(cdChunks);
  const cdOffset = offset;
  const cdSize = cdBuf.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

/**
 * Creates a zip archive file on disk from a directory.
 */
export function createZipArchive(packageDir, zipPath) {
  const topDirName = path.basename(packageDir);
  const entries = [];

  function collect(dir, relPrefix = '') {
    const list = readdirSync(dir);
    for (const item of list) {
      if (item.startsWith('.') || item.endsWith('.zip')) continue;
      const full = path.join(dir, item);
      const rel = relPrefix ? `${relPrefix}/${item}` : item;
      const st = statSync(full);
      if (st.isSymbolicLink()) {
        throw new Error(`Symlink found in skill package: ${rel}`);
      }
      if (st.isDirectory()) {
        collect(full, rel);
      } else if (st.isFile()) {
        const ext = path.extname(item).toLowerCase();
        if (['.exe', '.bin', '.so', '.dylib', '.dll', '.class'].includes(ext)) {
          throw new Error(`Binary executable found in skill package: ${rel}`);
        }
        entries.push({
          path: rel,
          data: readFileSync(full),
        });
      }
    }
  }

  collect(packageDir);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const buf = createZipBuffer(entries, topDirName);
  writeFileSync(zipPath, buf);
}

/**
 * Generates a buyer-facing README.md for the standalone skill.
 */
export function generateBuyerReadme(skillName, skillContent, bundledFiles = []) {
  const fm = parseDocFrontmatter(skillContent);
  const title = skillName.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
  const desc = fm.description || `Autonomous agent skill for ${skillName}.`;

  const filesList = bundledFiles.map((f) => `- \`${f.replace(/\\/g, '/')}\``).join('\n');

  const md = `# ${title} (\`${skillName}\`)

${desc}

## Bundled Files

The standalone package bundles the following files:
- \`SKILL.md\` — Canonical agent skill instructions.
${filesList}

## Usage

Load this skill package into your agent harness or workspace.
Invoke the skill when you need ${skillName} capabilities per the triggers specified in \`SKILL.md\`.
`;

  return reflowMarkdown(md);
}

function unwrapInlineCode(rawText) {
  const trimmed = rawText.trim();
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed;
  }
  return `\`${trimmed}\``;
}

/**
 * Rewrites Markdown links and backticked script/template citations for standalone bundling.
 */
export function rewriteDocContent(
  content,
  { fileContext = 'root', skillName, bundledRefs = new Map(), hasScripts = false, hasTemplates = false },
) {
  let text = content;

  // 1. Rewrite backticked and raw script citations: scripts/check-doc-links.mjs -> ./scripts/check-doc-links.mjs
  if (hasScripts) {
    text = text.replace(/(?<!\.\/)(?<!\w)scripts\/check-doc-links\.mjs\b/g, './scripts/check-doc-links.mjs');
    text = text.replace(/(?<!\.\/)(?<!\w)scripts\/reflow-docs\.mjs\b/g, './scripts/reflow-docs.mjs');
  }

  // In template files (templates/AGENTS.md, templates/docs/adr/0001-record-architecture-decisions.md), unwrap all repo links to inline code
  if (fileContext === 'templates') {
    text = text.replace(/(!?\[([^\]]*)\])\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (fullMatch, prefix, linkText, rawTarget) => {
      if (prefix.startsWith('!')) return fullMatch;
      if (/^(https?:|mailto:)/i.test(rawTarget)) return fullMatch;
      if (rawTarget.startsWith('#')) return fullMatch;
      return unwrapInlineCode(linkText);
    });
    return text;
  }

  // 2. Rewrite Markdown links: [linkText](url)
  text = text.replace(/(!?\[([^\]]*)\])\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (fullMatch, prefix, linkText, rawTarget) => {
    if (prefix.startsWith('!')) return fullMatch;
    if (/^(https?:|mailto:)/i.test(rawTarget)) return fullMatch;

    const [targetPath, fragment] = rawTarget.split('#');
    const fragSuffix = fragment ? `#${fragment}` : '';

    // A. Local anchor link within same file: #something
    if (!targetPath && fragment) {
      return fullMatch;
    }

    // B. Buyer repo files -> unwrap to inline code
    if (
      targetPath.endsWith('docs/backlog.md') ||
      targetPath === 'docs/backlog.md' ||
      targetPath === 'backlog.md' ||
      targetPath.endsWith('AGENTS.md') ||
      targetPath === 'AGENTS.md'
    ) {
      if (targetPath.endsWith('rules/AGENTS.md') && bundledRefs.has('rules/AGENTS.md')) {
        // Handled below under bundled references
      } else {
        return unwrapInlineCode(linkText);
      }
    }

    // C. Starter template links for rig-onboard
    if (hasTemplates && targetPath.includes('templates/')) {
      if (targetPath.endsWith('templates/AGENTS.md')) {
        return `[${linkText}](./templates/AGENTS.md${fragSuffix})`;
      }
      if (targetPath.endsWith('templates/docs/backlog.md')) {
        return `[${linkText}](./templates/docs/backlog.md${fragSuffix})`;
      }
      if (targetPath.endsWith('templates/docs/adr/0001-record-architecture-decisions.md')) {
        return `[${linkText}](./templates/docs/adr/0001-record-architecture-decisions.md${fragSuffix})`;
      }
    }

    // D. Link pointing to the current skill itself
    if (
      targetPath.endsWith(`skills/${skillName}/SKILL.md`) ||
      targetPath.endsWith(`${skillName}/SKILL.md`) ||
      targetPath === 'SKILL.md' ||
      targetPath === './SKILL.md'
    ) {
      if (fileContext === 'references') {
        return `[${linkText}](../SKILL.md${fragSuffix})`;
      }
      return `[${linkText}](./SKILL.md${fragSuffix})`;
    }

    // E. Link pointing to a bundled reference document
    for (const [repoDocPath, refFilename] of bundledRefs.entries()) {
      if (targetPath.endsWith(repoDocPath) || targetPath.endsWith(path.basename(repoDocPath))) {
        if (fileContext === 'references') {
          return `[${linkText}](./${refFilename}${fragSuffix})`;
        }
        return `[${linkText}](./references/${refFilename}${fragSuffix})`;
      }
    }

    // F. Any other relative link pointing to repo docs/skills/rules/agents -> unwrap to inline code
    if (
      targetPath.includes('skills/') ||
      targetPath.includes('rules/') ||
      targetPath.includes('agents/') ||
      targetPath.includes('docs/') ||
      targetPath.endsWith('.md')
    ) {
      return unwrapInlineCode(linkText);
    }

    return fullMatch;
  });

  return text;
}

/**
 * Builds a single standalone skill package.
 */
export function buildSkillPackage(skillName, { outDir = 'dist/agensi', rigRoot = RIG_ROOT } = {}) {
  const packageDir = path.resolve(outDir, skillName);
  rmSync(packageDir, { recursive: true, force: true });
  mkdirSync(packageDir, { recursive: true });

  const skillSourcePath = path.join(rigRoot, 'skills', skillName, 'SKILL.md');
  if (!existsSync(skillSourcePath)) {
    throw new Error(`Skill source not found: ${skillSourcePath}`);
  }

  // 1. Determine bundled references, scripts, templates
  const bundledRefs = new Map();
  let hasScripts = false;
  let hasTemplates = false;

  if (skillName === 'dispatch') {
    bundledRefs.set('agents/worker.md', 'worker.md');
    bundledRefs.set('agents/verifier.md', 'verifier.md');
    bundledRefs.set('rules/ui-change-gate.md', 'ui-change-gate.md');
    bundledRefs.set('rules/contract-change-gate.md', 'contract-change-gate.md');
    bundledRefs.set('rules/AGENTS.md', 'AGENTS.md');
    bundledRefs.set('docs/field-notes.md', 'field-notes.md');
    bundledRefs.set('skills/merge-to-main/SKILL.md', 'merge-to-main.md');
    hasScripts = true;
  } else if (skillName === 'rig-onboard') {
    bundledRefs.set('agents/verifier.md', 'verifier.md');
    hasScripts = true;
    hasTemplates = true;
  } else if (skillName === 'doc-audit' || skillName === 'backlog-audit' || skillName === 'wrap-up') {
    bundledRefs.set('docs/adr/0001-record-architecture-decisions.md', '0001-record-architecture-decisions.md');
    hasScripts = true;
  }

  // 2. Hydrate & write SKILL.md
  const rawSkill = readFileSync(skillSourcePath, 'utf8');
  let hydratedSkill = hydrateText(rawSkill, AGENSI_PROFILE, {
    harness: 'agensi',
    distribution: 'standalone',
  });

  hydratedSkill = rewriteDocContent(hydratedSkill, {
    fileContext: 'root',
    skillName,
    bundledRefs,
    hasScripts,
    hasTemplates,
  });

  hydratedSkill = reflowMarkdown(hydratedSkill);
  writeFileSync(path.join(packageDir, 'SKILL.md'), hydratedSkill, 'utf8');

  const bundledFileList = [];

  // 3. Bundle references/
  if (bundledRefs.size > 0) {
    const refsDir = path.join(packageDir, 'references');
    mkdirSync(refsDir, { recursive: true });

    for (const [repoRelPath, refFilename] of bundledRefs.entries()) {
      const srcPath = path.join(rigRoot, repoRelPath);
      const raw = readFileSync(srcPath, 'utf8');
      let hydrated = hydrateText(raw, AGENSI_PROFILE, {
        harness: 'agensi',
        distribution: 'standalone',
      });

      hydrated = stripAgentFrontmatter(hydrated);

      hydrated = rewriteDocContent(hydrated, {
        fileContext: 'references',
        skillName,
        bundledRefs,
        hasScripts,
        hasTemplates,
      });

      hydrated = reflowMarkdown(hydrated);
      writeFileSync(path.join(refsDir, refFilename), hydrated, 'utf8');
      bundledFileList.push(`references/${refFilename}`);
    }
  }

  // 4. Bundle scripts/
  if (hasScripts) {
    const scriptsDir = path.join(packageDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    const cdlSrc = path.join(rigRoot, 'scripts/check-doc-links.mjs');
    const rfSrc = path.join(rigRoot, 'scripts/reflow-docs.mjs');

    writeFileSync(path.join(scriptsDir, 'check-doc-links.mjs'), readFileSync(cdlSrc, 'utf8'), 'utf8');
    writeFileSync(path.join(scriptsDir, 'reflow-docs.mjs'), readFileSync(rfSrc, 'utf8'), 'utf8');

    bundledFileList.push('scripts/check-doc-links.mjs');
    bundledFileList.push('scripts/reflow-docs.mjs');
  }

  // 5. Bundle templates/ (for rig-onboard)
  if (hasTemplates) {
    const templatesDir = path.join(packageDir, 'templates');
    mkdirSync(path.join(templatesDir, 'docs/adr'), { recursive: true });

    // templates/AGENTS.md merged with hydrated rules/AGENTS.md
    const rulesAgentsRaw = readFileSync(path.join(rigRoot, 'rules/AGENTS.md'), 'utf8');
    let hydratedRules = hydrateText(rulesAgentsRaw, AGENSI_PROFILE, {
      harness: 'agensi',
      distribution: 'standalone',
    });
    hydratedRules = rewriteDocContent(hydratedRules, {
      fileContext: 'templates',
      skillName,
      bundledRefs: new Map(),
      hasScripts,
      hasTemplates,
    });

    const managedBlock = `${MANAGED_AGENTS_START}\n${MANAGED_AGENTS_HEADER}\n${hydratedRules.trim()}\n${MANAGED_AGENTS_END}`;
    const templateContextRaw = readFileSync(path.join(rigRoot, 'templates/AGENTS.md'), 'utf8');

    // Build docs index block for starter templates
    const tempDir = path.join(templatesDir, 'docs');
    const backlogRaw = readFileSync(path.join(rigRoot, 'templates/docs/backlog.md'), 'utf8');
    writeFileSync(path.join(tempDir, 'backlog.md'), backlogRaw, 'utf8');

    const adrRaw = readFileSync(path.join(rigRoot, 'templates/docs/adr/0001-record-architecture-decisions.md'), 'utf8');
    const adrRewritten = rewriteDocContent(adrRaw, {
      fileContext: 'templates',
      skillName,
      bundledRefs: new Map(),
      hasScripts,
      hasTemplates,
    });
    writeFileSync(path.join(tempDir, 'adr/0001-record-architecture-decisions.md'), reflowMarkdown(adrRewritten), 'utf8');

    const docsBlock = buildDocsIndexBlock(templatesDir);
    const mergedAgents = mergeManagedAgentsFile('', managedBlock, templateContextRaw, docsBlock);
    writeFileSync(path.join(templatesDir, 'AGENTS.md'), reflowMarkdown(mergedAgents), 'utf8');

    bundledFileList.push('templates/AGENTS.md');
    bundledFileList.push('templates/docs/backlog.md');
    bundledFileList.push('templates/docs/adr/0001-record-architecture-decisions.md');
  }

  // 6. Generate README.md
  bundledFileList.sort();
  const readmeContent = generateBuyerReadme(skillName, hydratedSkill, bundledFileList);
  writeFileSync(path.join(packageDir, 'README.md'), readmeContent, 'utf8');

  // 7. Run built-in verification check
  verifySkillPackage(packageDir);

  // 8. Create <slug>.zip archive
  const zipPath = path.resolve(outDir, `${skillName}.zip`);
  createZipArchive(packageDir, zipPath);

  return {
    packageDir,
    zipPath,
    bundledFiles: ['SKILL.md', 'README.md', ...bundledFileList],
  };
}

/**
 * Slugify heading text identically to check-doc-links.mjs.
 */
function slugifyHeading(headingText) {
  return headingText
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');
}

/**
 * Built-in verification check on every generated <slug>/ directory asserting:
 *   - valid name + description frontmatter in SKILL.md,
 *   - zero {{...}} or <!-- RIG: tokens across all bundled files,
 *   - zero ../ links escaping <slug>/,
 *   - existing targets on disk for every relative Markdown link and ./scripts/ or ./templates/ path,
 *   - passing one-sentence-per-line formatting (reflowMarkdown).
 */
export function verifySkillPackage(packageDir) {
  const errors = [];
  const slug = path.basename(packageDir);

  // 1. Verify SKILL.md frontmatter
  const skillMdPath = path.join(packageDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    errors.push(`Missing SKILL.md in ${packageDir}`);
    throw new Error(`Skill package verification failed:\n  ${errors.join('\n  ')}`);
  }

  const skillContent = readFileSync(skillMdPath, 'utf8');
  const fm = parseDocFrontmatter(skillContent);
  if (!fm.name || fm.name !== slug) {
    errors.push(`SKILL.md frontmatter 'name' must equal '${slug}', found '${fm.name}'`);
  }
  if (!fm.description || typeof fm.description !== 'string' || fm.description.trim().length === 0) {
    errors.push(`SKILL.md frontmatter 'description' must be a non-empty string`);
  }

  // Collect all files in packageDir
  const allFiles = [];
  function walk(dir) {
    for (const item of readdirSync(dir)) {
      if (item.startsWith('.')) continue;
      const full = path.join(dir, item);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        allFiles.push(full);
      }
    }
  }
  walk(packageDir);

  // Map of heading slugs for all markdown files
  const fileSlugs = new Map();
  for (const f of allFiles) {
    if (f.endsWith('.md')) {
      const content = readFileSync(f, 'utf8');
      const slugs = new Set();
      const slugCounts = new Map();
      let inFence = false;
      for (const line of content.split(/\r?\n/)) {
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;
        const h = /^\s*#{1,6}\s+(.+?)\s*$/.exec(line);
        if (h) {
          const base = slugifyHeading(h[1]);
          const count = slugCounts.get(base) ?? 0;
          slugCounts.set(base, count + 1);
          slugs.add(count === 0 ? base : `${base}-${count}`);
        }
      }
      fileSlugs.set(f, slugs);
    }
  }

  // 2. Check each file for invariants
  for (const f of allFiles) {
    const relFromPackage = path.relative(packageDir, f).replace(/\\/g, '/');
    const content = readFileSync(f, 'utf8');

    // A. Zero {{...}} or <!-- RIG: tokens
    const leftoverPlaceholder = content.match(/\{\{[A-Z0-9_]+\}\}/);
    if (leftoverPlaceholder) {
      errors.push(`${relFromPackage}: contains unhydrated placeholder '${leftoverPlaceholder[0]}'`);
    }

    const leftoverComment = content.match(/<!--\s*RIG:[\s\S]*?-->/);
    if (leftoverComment) {
      errors.push(`${relFromPackage}: contains leftover RIG comment '${leftoverComment[0]}'`);
    }

    if (f.endsWith('.md')) {
      // B. One sentence per line
      const reflowed = reflowMarkdown(content);
      if (reflowed !== content) {
        errors.push(`${relFromPackage}: does not match one-sentence-per-line formatting (reflowMarkdown)`);
      }

      // C. Relative Markdown links check
      let inFence = false;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;

        // Check relative markdown links
        for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
          const rawTarget = m[1];
          if (/^(https?:|mailto:)/i.test(rawTarget)) continue;

          const [targetPath, fragment] = rawTarget.split('#');

          // Local anchor within same file
          if (!targetPath && fragment) {
            const slugs = fileSlugs.get(f);
            if (!slugs || !slugs.has(fragment.toLowerCase())) {
              errors.push(`${relFromPackage}:${i + 1}: broken local anchor #${fragment}`);
            }
            continue;
          }

          // Resolve target relative to current file's directory
          const resolvedTarget = path.normalize(path.resolve(path.dirname(f), targetPath));

          // Check if link escapes package directory
          const relToPackage = path.relative(packageDir, resolvedTarget);
          if (relToPackage.startsWith('..') || path.isAbsolute(relToPackage)) {
            errors.push(`${relFromPackage}:${i + 1}: link escapes package root: '${rawTarget}'`);
            continue;
          }

          // Check if target file exists on disk
          if (!existsSync(resolvedTarget)) {
            errors.push(`${relFromPackage}:${i + 1}: broken relative link '${rawTarget}' — target does not exist on disk`);
            continue;
          }

          // Check anchor if present
          if (fragment && resolvedTarget.endsWith('.md')) {
            const targetSlugs = fileSlugs.get(resolvedTarget);
            if (!targetSlugs || !targetSlugs.has(fragment.toLowerCase())) {
              errors.push(`${relFromPackage}:${i + 1}: broken anchor #${fragment} in ${targetPath}`);
            }
          }
        }

        // Check backticked ./scripts/, ./templates/, ./references/ citations
        for (const m of line.matchAll(/`(\.\/(?:scripts|templates|references)\/[^`]+)`/g)) {
          const citedPath = m[1];
          const resolved = path.normalize(path.resolve(packageDir, citedPath));
          if (!existsSync(resolved)) {
            errors.push(`${relFromPackage}:${i + 1}: cited path '${citedPath}' does not exist on disk`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Skill package verification failed for '${slug}':\n  ${errors.join('\n  ')}`);
  }

  return { valid: true, errorCount: 0 };
}

/**
 * Builds all target skills into <outDir>.
 */
export function buildAgensiSkills({ outDir = 'dist/agensi', rigRoot = RIG_ROOT, skills = TARGET_SKILLS } = {}) {
  const resolvedOutDir = path.resolve(rigRoot, outDir);
  mkdirSync(resolvedOutDir, { recursive: true });

  const results = [];
  for (const skill of skills) {
    const res = buildSkillPackage(skill, { outDir: resolvedOutDir, rigRoot });
    results.push(res);
  }
  return results;
}

// CLI entry point
function isMainScript() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainScript()) {
  const args = process.argv.slice(2);
  let outDir = 'dist/agensi';
  let targetSkill = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--outDir' && args[i + 1]) {
      outDir = args[++i];
    } else if (args[i] === '--skill' && args[i + 1]) {
      targetSkill = args[++i];
    }
  }

  const skillsToBuild = targetSkill ? [targetSkill] : TARGET_SKILLS;
  console.log(`Building Agensi skill packages into '${outDir}'...`);
  const res = buildAgensiSkills({ outDir, skills: skillsToBuild });
  console.log(`Successfully built ${res.length} skill package(s):`);
  for (const r of res) {
    console.log(`  - ${path.basename(r.packageDir)} (${r.bundledFiles.length} files) -> ${path.basename(r.zipPath)}`);
  }
}
