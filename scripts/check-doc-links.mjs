#!/usr/bin/env node
// Fails if the documentation's internal link graph is broken, or if a committed
// doc leans on something that isn't committed.
//
// Six rules, all cheap:
//   1. Every relative Markdown link resolves to a file that exists — and, if it
//      carries a #fragment, to a heading that exists in that file.
//   2. Cross-references use relative Markdown links and nothing else. [[wiki-style]]
//      refs, glob paths like `docs/adr/0001-*.md`, and bare backticked doc paths like  check-doc-links:ignore
//      `docs/backlog.md` (unless struck through: ~~`docs/gone.md`~~) are banned.       check-doc-links:ignore
//   3. Every doc under docs/ is reachable by following links from an entry point
//      a cold session actually starts from (AGENTS.md, CLAUDE.md,
//      GEMINI.md, a SKILL.md, or a rule under rules/ or .claude/rules/).
//   4. Every backticked path into the repo (`src/…`, `scripts/…`, `hooks/…`, etc.)
//      names a file that exists — or, when deliberately removed, is struck through:
//      ~~`scripts/gone.mjs`~~.
//   5. Published-Artifact links (claude.ai/code/artifact/...) appear only under a
//      trailing "References"/"Visual record" heading.
//   6. Code comments cite docs the same way docs do: a `docs/…md` path resolves,
//      a #fragment names a real heading, and glob paths are banned here too.
//
// Usage: node scripts/check-doc-links.mjs [target-dir] [--fix]

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MANAGED_AGENTS_START = '<!-- AGENT-RIG:START -->';
export const MANAGED_AGENTS_END = '<!-- AGENT-RIG:END -->';
export const MANAGED_AGENTS_HEADER = '<!-- Managed by `rig init` / `rig update`. Do not edit between AGENT-RIG:START and AGENT-RIG:END. -->';

export const MANAGED_DOCS_START = '<!-- AGENT-RIG:DOCS:START -->';
export const MANAGED_DOCS_END = '<!-- AGENT-RIG:DOCS:END -->';
export const MANAGED_DOCS_HEADER = '<!-- Managed by `rig update` / `rig check-docs`. Do not edit between AGENT-RIG:DOCS:START and AGENT-RIG:DOCS:END. -->';

export function extractManagedAgentsBlock(content) {
  if (typeof content !== 'string') return { block: null, before: '', after: '', hasBlock: false };
  const startIdx = content.indexOf(MANAGED_AGENTS_START);
  if (startIdx === -1) return { block: null, before: content, after: '', hasBlock: false };
  const endIdx = content.indexOf(MANAGED_AGENTS_END, startIdx + MANAGED_AGENTS_START.length);
  if (endIdx === -1) return { block: null, before: content, after: '', hasBlock: false };
  const fullEnd = endIdx + MANAGED_AGENTS_END.length;
  const block = content.slice(startIdx, fullEnd);
  const before = content.slice(0, startIdx);
  const after = content.slice(fullEnd);
  return { block, before, after, hasBlock: true };
}

export function parseDocFrontmatter(content) {
  if (typeof content !== 'string') return {};
  const cleaned = content.replace(/^\uFEFF/, '');
  const match = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const raw = match[1];
  const result = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    let val = keyMatch[2].trim();
    if (/^true\b/i.test(val)) {
      result[key] = true;
      continue;
    }
    if (/^false\b/i.test(val)) {
      result[key] = false;
      continue;
    }
    if (val === '>' || val === '>-' || val === '|' || val === '|-') {
      const collected = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        i++;
        collected.push(lines[i].trim());
      }
      val = collected.join(' ').trim();
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val.trim();
  }
  return result;
}

export function parseAdrStatus(filePath) {
  if (!existsSync(filePath)) return null;
  let content = '';
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const h1Match = content.match(/^\s*#\s+(.+)$/m);
  const title = h1Match ? h1Match[1].trim() : path.basename(filePath, '.md');
  const statusMatch = content.match(/^\s*##\s+Status\s*\n+([^\n]+)/m);
  const rawStatus = statusMatch ? statusMatch[1].trim() : '';

  let statusTag = null;
  if (/^superseded\b/i.test(rawStatus)) {
    const byMatch = rawStatus.match(/by\s+(\[?ADR\s*\d+[^\]\n]*\]?)/i) || rawStatus.match(/by\s+([^.\n]+)/i);
    statusTag = byMatch ? `Superseded by ${byMatch[1].replace(/[[\]]/g, '').trim()}` : 'Superseded';
  } else if (/^deprecated\b/i.test(rawStatus)) {
    statusTag = 'Deprecated';
  } else if (/^proposed\b/i.test(rawStatus)) {
    statusTag = 'Proposed';
  } else if (/^rejected\b/i.test(rawStatus)) {
    statusTag = 'Rejected';
  }
  if (statusTag) {
    statusTag = statusTag.replace(/\.+$/, '').trim();
  }
  const fm = parseDocFrontmatter(content);
  const res = { title, rawStatus, statusTag };
  if (fm.description) {
    res.description = fm.description;
  }
  return res;
}

export function isEphemeralDoc(filePath, content) {
  const norm = filePath.replace(/\\/g, '/');
  if (norm.includes('/docs/epics/') || norm.startsWith('docs/epics/')) {
    return true;
  }
  if (typeof content === 'string') {
    const fm = parseDocFrontmatter(content);
    if (fm.ephemeral === true) return true;
    if (/^---\n[\s\S]*?\bephemeral:\s*true\b[\s\S]*?\n---/m.test(content)) return true;
    if (/<!--\s*ephemeral\s*-->/i.test(content)) return true;
    if (/delete this file (?:when|after|once)\b/i.test(content)) return true;
  }
  return false;
}

export function isCollectionDir(dirPath) {
  if (!dirPath || !existsSync(dirPath)) return false;
  try {
    if (!statSync(dirPath).isDirectory()) return false;
    const readmePath = path.join(dirPath, 'README.md');
    if (!existsSync(readmePath) || !statSync(readmePath).isFile()) return false;
    const content = readFileSync(readmePath, 'utf8');
    const fm = parseDocFrontmatter(content);
    return fm.collection === true;
  } catch {
    return false;
  }
}

export function findCollectionDirs(docsDir) {
  if (!docsDir || !existsSync(docsDir)) return [];
  const results = [];
  function scan(currentDir) {
    try {
      const entries = readdirSync(currentDir).sort();
      for (const entry of entries) {
        if (entry === 'epics') continue;
        const fullPath = path.join(currentDir, entry);
        try {
          if (statSync(fullPath).isDirectory()) {
            if (isCollectionDir(fullPath)) {
              results.push(fullPath);
            }
            scan(fullPath);
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  scan(docsDir);
  return results;
}

export function buildCollectionDocsIndexBlock(collectionDir, repoRoot = process.cwd()) {
  const absCollectionDir = path.isAbsolute(collectionDir) ? collectionDir : path.resolve(repoRoot, collectionDir);
  if (!existsSync(absCollectionDir)) return '';
  try {
    if (!statSync(absCollectionDir).isDirectory()) return '';
  } catch {
    return '';
  }

  const items = [];

  // 1. Immediate markdown files in collectionDir (excluding README.md)
  try {
    const topFiles = readdirSync(absCollectionDir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md' && statSync(path.join(absCollectionDir, f)).isFile())
      .sort();
    for (const f of topFiles) {
      const fullPath = path.join(absCollectionDir, f);
      const content = readFileSync(fullPath, 'utf8');
      const relForEphemeral = path.relative(repoRoot, fullPath).replace(/\\/g, '/');
      if (isEphemeralDoc(relForEphemeral, content)) continue;
      const fm = parseDocFrontmatter(content);
      const h1Match = content.match(/^\s*#\s+(.+)$/m);
      const title = h1Match ? h1Match[1].trim() : f;
      items.push({
        relPath: f,
        title,
        statusTag: null,
        description: fm.description || null,
      });
    }
  } catch {
    // ignore
  }

  // 2. ADR files in adr/ if present
  const adrDir = path.join(absCollectionDir, 'adr');
  if (existsSync(adrDir)) {
    if (isCollectionDir(adrDir)) {
      try {
        const readmePath = path.join(adrDir, 'README.md');
        const content = readFileSync(readmePath, 'utf8');
        const fm = parseDocFrontmatter(content);
        const h1Match = content.match(/^\s*#\s+(.+)$/m);
        const title = h1Match ? h1Match[1].trim() : 'adr';
        items.push({
          relPath: 'adr/README.md',
          title,
          statusTag: null,
          description: fm.description || null,
        });
      } catch {
        // ignore
      }
    } else {
      try {
        const adrFiles = readdirSync(adrDir)
          .filter((f) => f.endsWith('.md') && statSync(path.join(adrDir, f)).isFile())
          .sort();
        for (const f of adrFiles) {
          const fullPath = path.join(adrDir, f);
          const { title, statusTag, description = null } = parseAdrStatus(fullPath) || {};
          items.push({
            relPath: `adr/${f}`,
            title: title || f,
            statusTag: statusTag || null,
            description: description || null,
          });
        }
      } catch {
        // ignore
      }
    }
  }

  // 3. Subdirectories in collectionDir (excluding epics and adr)
  try {
    const subEntries = readdirSync(absCollectionDir)
      .filter((entry) => {
        if (entry === 'adr' || entry === 'epics') return false;
        const subPath = path.join(absCollectionDir, entry);
        return statSync(subPath).isDirectory();
      })
      .sort();

    function walkColSubdir(subRel) {
      const subDir = path.join(absCollectionDir, subRel);
      if (isCollectionDir(subDir)) {
        const readmePath = path.join(subDir, 'README.md');
        const content = readFileSync(readmePath, 'utf8');
        const fm = parseDocFrontmatter(content);
        const h1Match = content.match(/^\s*#\s+(.+)$/m);
        const title = h1Match ? h1Match[1].trim() : path.basename(subDir);
        items.push({
          relPath: path.join(subRel, 'README.md').replace(/\\/g, '/'),
          title,
          statusTag: null,
          description: fm.description || null,
        });
        return;
      }
      for (const entry of readdirSync(subDir).sort()) {
        const fullPath = path.join(subDir, entry);
        const rel = path.join(subRel, entry).replace(/\\/g, '/');
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          walkColSubdir(rel);
        } else if (st.isFile() && entry.endsWith('.md')) {
          const content = readFileSync(fullPath, 'utf8');
          const relForEphemeral = path.relative(repoRoot, fullPath).replace(/\\/g, '/');
          if (isEphemeralDoc(relForEphemeral, content)) continue;
          const fm = parseDocFrontmatter(content);
          const h1Match = content.match(/^\s*#\s+(.+)$/m);
          const title = h1Match ? h1Match[1].trim() : entry;
          items.push({ relPath: rel, title, statusTag: null, description: fm.description || null });
        }
      }
    }

    for (const sub of subEntries) {
      walkColSubdir(sub);
    }
  } catch {
    // ignore
  }

  if (items.length === 0) return '';

  const lines = [
    MANAGED_DOCS_START,
    MANAGED_DOCS_HEADER,
    '## Documentation Index',
    '',
  ];
  for (const item of items) {
    const tag = item.statusTag ? ` (${item.statusTag})` : '';
    const desc = item.description ? ` — ${item.description}` : '';
    lines.push(`- [\`${item.relPath}\`](${item.relPath}) — ${item.title}${tag}${desc}`);
  }
  lines.push(MANAGED_DOCS_END);
  return lines.join('\n');
}

export function buildDocsIndexBlock(repoRoot = process.cwd(), targetCollectionRel = null) {
  if (targetCollectionRel) {
    const colDir = path.isAbsolute(targetCollectionRel)
      ? targetCollectionRel
      : path.resolve(repoRoot, targetCollectionRel);
    return buildCollectionDocsIndexBlock(colDir, repoRoot);
  }

  const docsDir = path.join(repoRoot, 'docs');
  if (!existsSync(docsDir)) return '';
  try {
    if (!statSync(docsDir).isDirectory()) return '';
  } catch {
    return '';
  }

  const items = [];

  // 1. Top-level markdown files in docs
  try {
    const topFiles = readdirSync(docsDir)
      .filter((f) => f.endsWith('.md') && statSync(path.join(docsDir, f)).isFile())
      .sort();
    for (const f of topFiles) {
      const fullPath = path.join(docsDir, f);
      const content = readFileSync(fullPath, 'utf8');
      if (isEphemeralDoc(`docs/${f}`, content)) continue;
      const fm = parseDocFrontmatter(content);
      const h1Match = content.match(/^\s*#\s+(.+)$/m);
      const title = h1Match ? h1Match[1].trim() : f;
      items.push({ relPath: `docs/${f}`, title, statusTag: null, description: fm.description || null });
    }
  } catch {
    // ignore
  }

  // 2. ADR files in docs/adr
  const adrDir = path.join(docsDir, 'adr');
  if (existsSync(adrDir)) {
    if (isCollectionDir(adrDir)) {
      try {
        const readmePath = path.join(adrDir, 'README.md');
        const content = readFileSync(readmePath, 'utf8');
        const fm = parseDocFrontmatter(content);
        const h1Match = content.match(/^\s*#\s+(.+)$/m);
        const title = h1Match ? h1Match[1].trim() : 'adr';
        items.push({ relPath: 'docs/adr/README.md', title, statusTag: null, description: fm.description || null });
      } catch {
        // ignore
      }
    } else {
      try {
        const adrFiles = readdirSync(adrDir)
          .filter((f) => f.endsWith('.md') && statSync(path.join(adrDir, f)).isFile())
          .sort();
        for (const f of adrFiles) {
          const fullPath = path.join(adrDir, f);
          const { title, statusTag, description = null } = parseAdrStatus(fullPath) || {};
          items.push({ relPath: `docs/adr/${f}`, title: title || f, statusTag: statusTag || null, description: description || null });
        }
      } catch {
        // ignore
      }
    }
  }

  // 3. Other permanent subdirectories under docs/ (excluding epics and adr)
  try {
    const subEntries = readdirSync(docsDir)
      .filter((entry) => {
        if (entry === 'adr' || entry === 'epics') return false;
        const subPath = path.join(docsDir, entry);
        return statSync(subPath).isDirectory();
      })
      .sort();

    function walkSubdir(subRel) {
      const subDir = path.join(repoRoot, subRel);
      if (isCollectionDir(subDir)) {
        const readmePath = path.join(subDir, 'README.md');
        const content = readFileSync(readmePath, 'utf8');
        const fm = parseDocFrontmatter(content);
        const h1Match = content.match(/^\s*#\s+(.+)$/m);
        const title = h1Match ? h1Match[1].trim() : path.basename(subDir);
        items.push({
          relPath: path.join(subRel, 'README.md').replace(/\\/g, '/'),
          title,
          statusTag: null,
          description: fm.description || null,
        });
        return;
      }
      for (const entry of readdirSync(subDir).sort()) {
        const fullPath = path.join(subDir, entry);
        const rel = path.join(subRel, entry).replace(/\\/g, '/');
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          walkSubdir(rel);
        } else if (st.isFile() && entry.endsWith('.md')) {
          const content = readFileSync(fullPath, 'utf8');
          if (isEphemeralDoc(rel, content)) continue;
          const fm = parseDocFrontmatter(content);
          const h1Match = content.match(/^\s*#\s+(.+)$/m);
          const title = h1Match ? h1Match[1].trim() : entry;
          items.push({ relPath: rel, title, statusTag: null, description: fm.description || null });
        }
      }
    }

    for (const sub of subEntries) {
      walkSubdir(`docs/${sub}`);
    }
  } catch {
    // ignore
  }

  if (items.length === 0) return '';

  const lines = [
    MANAGED_DOCS_START,
    MANAGED_DOCS_HEADER,
    '## Documentation Index',
    '',
  ];
  for (const item of items) {
    const tag = item.statusTag ? ` (${item.statusTag})` : '';
    const desc = item.description ? ` — ${item.description}` : '';
    lines.push(`- [\`${item.relPath}\`](${item.relPath}) — ${item.title}${tag}${desc}`);
  }
  lines.push(MANAGED_DOCS_END);
  return lines.join('\n');
}

export function updateDocManagedDocsBlock(content, newBlock) {
  const { hasBlock, before, after } = extractManagedDocsBlock(content);
  if (hasBlock) {
    if (!newBlock) {
      const b = before.trimEnd();
      const a = after.trim();
      return b && a ? `${b}\n\n${a}\n` : b ? `${b}\n` : a ? `${a}\n` : '';
    }
    return before + newBlock + after;
  }
  if (!newBlock) return content;
  const trimmed = (content || '').trimEnd();
  return trimmed ? `${trimmed}\n\n${newBlock}\n` : `${newBlock}\n`;
}

export function extractManagedDocsBlock(content) {
  if (typeof content !== 'string') return { block: null, before: '', after: '', hasBlock: false };
  const startIdx = content.indexOf(MANAGED_DOCS_START);
  if (startIdx === -1) return { block: null, before: content, after: '', hasBlock: false };
  const endIdx = content.indexOf(MANAGED_DOCS_END, startIdx + MANAGED_DOCS_START.length);
  if (endIdx === -1) return { block: null, before: content, after: '', hasBlock: false };
  const fullEnd = endIdx + MANAGED_DOCS_END.length;
  const block = content.slice(startIdx, fullEnd);
  const before = content.slice(0, startIdx);
  const after = content.slice(fullEnd);
  return { block, before, after, hasBlock: true };
}

export function mergeManagedAgentsFile(existingContent, managedBlock, defaultProjectContext = '', docsIndexBlock = undefined) {
  const normRules = managedBlock ? managedBlock.trim() : '';

  // 1. Extract rules block if present
  const { hasBlock: hasRules, before: beforeRules, after: afterRules } = extractManagedAgentsBlock(existingContent || '');
  let remainder = hasRules
    ? (beforeRules.trim() ? beforeRules.trim() + '\n\n' : '') + afterRules.trim()
    : (existingContent || '').trim();

  // 2. Extract docs index block from remainder if present
  const { hasBlock: hasDocs, before: beforeDocs, after: afterDocs, block: existingDocsBlock } = extractManagedDocsBlock(remainder);
  let userContext = hasDocs
    ? (beforeDocs.trim() ? beforeDocs.trim() + '\n\n' : '') + afterDocs.trim()
    : remainder;
  userContext = userContext.trim();

  if (!userContext && defaultProjectContext) {
    userContext = defaultProjectContext.trim();
  }

  // 3. Determine effective docs block
  let effectiveDocs = '';
  if (docsIndexBlock !== undefined) {
    effectiveDocs = docsIndexBlock ? docsIndexBlock.trim() : '';
  } else if (hasDocs) {
    effectiveDocs = existingDocsBlock.trim();
  }

  // 4. Assemble in canonical order
  const parts = [];
  if (hasRules && beforeRules.trim()) parts.push(beforeRules.trim());
  if (normRules) parts.push(normRules);
  if (effectiveDocs) parts.push(effectiveDocs);
  if (userContext) parts.push(userContext);

  return parts.join('\n\n') + '\n';
}

const DEFAULTS = {
  docRoots: [
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    'docs',
    'skills',
    'agents',
    'rules',
    '.claude/skills',
    '.claude/rules',
    '.agents/skills',
    '.agents/rules',
  ],
  codeRoots: ['src', 'lib', 'app', 'pkg', 'cmd', 'internal', 'public', 'scripts', 'hooks', 'tests', 'test', 'bin'],
  repoPathPrefixes: [
    'src',
    'lib',
    'app',
    'pkg',
    'cmd',
    'internal',
    'public',
    'scripts',
    'hooks',
    'skills',
    'agents',
    'rules',
    'tests',
    'test',
    'db',
    'bin',
    'templates',
    '.github',
  ],
  epicMaxBytes: 8_000,
  adrMaxBytes: 24_000,
};

const COMMON_EXTS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx',
  'go', 'py', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'rb',
  'json', 'yaml', 'yml', 'toml', 'md', 'css', 'scss', 'html',
  'sql', 'sh', 'bash', 'zsh', 'txt', 'xml', 'svg', 'lock',
]);

function loadConfig() {
  if (!existsSync('.doclinksrc.json')) return DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync('.doclinksrc.json', 'utf8'));
    return {
      docRoots: Array.isArray(raw.docRoots) ? raw.docRoots : DEFAULTS.docRoots,
      codeRoots: Array.isArray(raw.codeRoots) ? raw.codeRoots : DEFAULTS.codeRoots,
      repoPathPrefixes: Array.isArray(raw.repoPathPrefixes) ? raw.repoPathPrefixes : DEFAULTS.repoPathPrefixes,
      epicMaxBytes: typeof raw.epicMaxBytes === 'number' ? raw.epicMaxBytes : DEFAULTS.epicMaxBytes,
      adrMaxBytes: typeof raw.adrMaxBytes === 'number' ? raw.adrMaxBytes : DEFAULTS.adrMaxBytes,
    };
  } catch {
    return DEFAULTS;
  }
}

const isEntryPoint = (f) =>
  f === 'AGENTS.md' ||
  f === 'CLAUDE.md' ||
  f === 'GEMINI.md' ||
  f.endsWith('SKILL.md') ||
  f.startsWith(`rules${path.sep}`) ||
  f.startsWith(`.claude${path.sep}rules${path.sep}`) ||
  f.startsWith(`.agents${path.sep}rules${path.sep}`);

function walk(target, out = []) {
  if (!existsSync(target)) return out;
  if (statSync(target).isFile()) {
    if (target.endsWith('.md')) out.push(target);
    return out;
  }
  for (const entry of readdirSync(target)) {
    walk(path.join(target, entry), out);
  }
  return out;
}

const CODE_EXT = /\.(?:m?js|cjs|ts|tsx|jsx|py|rs|go|sh|bash|zsh|sql|rb|java|kt|c|cc|cpp|h|hpp)$/;

function walkCode(target, out = []) {
  if (!existsSync(target)) return out;
  if (statSync(target).isFile()) {
    if (CODE_EXT.test(target)) out.push(target);
    return out;
  }
  for (const entry of readdirSync(target)) {
    if (entry === 'node_modules' || entry === 'vendor' || entry === 'dist' || entry === 'build' || entry === 'target') {
      continue;
    }
    walkCode(path.join(target, entry), out);
  }
  return out;
}

function slugify(headingText) {
  return headingText
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');
}

function parseDoc(file, cfg = DEFAULTS) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const slugs = new Set();
  const slugCounts = new Map();
  const links = [];
  const bareRefs = [];
  const repoPaths = [];
  const externalUrls = [];

  const prefixAlt = (cfg?.repoPathPrefixes ?? DEFAULTS.repoPathPrefixes).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const repoPathRe = new RegExp(`^(?:${prefixAlt})\\/\\S+$`);
  const docPrefixRe = /^(?:docs|skills|rules|\.claude|\.agents)\//;

  let inFence = false;
  let inManagedBlock = false;
  let currentHeading = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('<!-- AGENT-RIG:START -->') || line.includes('<!-- AGENT-RIG:DOCS:START -->')) {
      inManagedBlock = true;
    }
    if (line.includes('<!-- AGENT-RIG:END -->') || line.includes('<!-- AGENT-RIG:DOCS:END -->')) {
      inManagedBlock = false;
    }
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const h = /^\s*#{1,6}\s+(.+?)\s*$/.exec(line);
    if (h) {
      currentHeading = h[1].trim();
      const base = slugify(h[1]);
      const n = slugCounts.get(base) ?? 0;
      slugCounts.set(base, n + 1);
      slugs.add(n === 0 ? base : `${base}-${n}`);
    }

    for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const raw = m[1];
      if (/^https?:\/\//i.test(raw)) {
        externalUrls.push({ line: i + 1, url: raw, heading: currentHeading });
        continue;
      }
      if (/^(mailto:|#)/i.test(raw)) {
        if (raw.startsWith('#')) {
          links.push({ line: i + 1, targetFile: file, fragment: raw.slice(1), raw, inManagedBlock });
        }
        continue;
      }
      const [relPath, fragment = null] = raw.split('#');
      const targetFile = path.normalize(path.join(path.dirname(file), relPath));
      links.push({ line: i + 1, targetFile, fragment, raw, inManagedBlock });
    }

    for (const m of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
      bareRefs.push({ line: i + 1, raw: m[0], reason: '[[wiki-style]] link — use a relative Markdown link' });
    }

    const withoutLinks = line
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/~~`[^`]+`~~/g, '')
      .replace(/~~[^~]+~~/g, '');
    for (const m of withoutLinks.matchAll(/(`+)\s*([\s\S]*?)\s*\1/g)) {
      const tok = m[2].trim();
      if (
        docPrefixRe.test(tok) &&
        (/[*?]/.test(tok) || /(?:^|\/)(?:[\w.-]+\.md|SKILL\.md)(?:#[\w-]+)?$/.test(tok))
      ) {
        const reason = /[*?]/.test(tok)
          ? 'glob path — link to the specific file'
          : 'bare backticked doc path — wrap in a Markdown link `[`…`](…)` (or strike through `~~`…`~~` if removed)';
        bareRefs.push({ line: i + 1, raw: `${m[1]}${tok}${m[1]}`, reason });
        continue;
      }
      const cleaned = tok.replace(/[.,;:!?)]+$/, '').replace(/#.*$/, '').replace(/:L?\d+.*$/, '');
      if (
        repoPathRe.test(cleaned) &&
        !docPrefixRe.test(cleaned) &&
        !/[*?<>[\]{}$]/.test(cleaned) &&
        !cleaned.includes('…') &&
        !cleaned.includes('...')
      ) {
        repoPaths.push({ line: i + 1, raw: `${m[1]}${tok}${m[1]}`, targetPath: path.normalize(cleaned), inManagedBlock });
      }
    }
  }

  return { slugs, links, bareRefs, repoPaths, externalUrls };
}

export function runCli(argv = process.argv.slice(2)) {
  const fix = argv.includes('--fix');
  const targetArg = argv.find((a) => !a.startsWith('-'));
  const targetRoot = targetArg ? path.resolve(targetArg) : process.cwd();
  process.chdir(targetRoot);

  const CFG = loadConfig();
  const DOC_ROOTS = CFG.docRoots;

  const files = DOC_ROOTS.flatMap((r) => walk(r));
  const parsed = new Map(files.map((f) => [path.normalize(f), parseDoc(f, CFG)]));

  function slugsFor(targetFile) {
    if (!parsed.has(targetFile) && existsSync(targetFile) && targetFile.endsWith('.md')) {
      parsed.set(targetFile, parseDoc(targetFile, CFG));
    }
    return parsed.get(targetFile)?.slugs;
  }

  const errors = [];

  const gitTracked = (() => {
    const r = spawnSync('git', ['ls-files'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return new Set(r.stdout.split('\n').filter(Boolean).map(path.normalize));
  })();

  const isOwnRepo = (() => {
    try {
      const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
      return pkg.name === 'agent-rig';
    } catch {
      return false;
    }
  })();

  const isStealthRepo = (() => {
    try {
      const r = spawnSync('git', ['check-ignore', '-q', 'AGENTS.md']);
      return r.status === 0;
    } catch {
      return false;
    }
  })();

  if (existsSync('docs') && statSync('docs').isDirectory()) {
    const expectedBlock = buildDocsIndexBlock(targetRoot);
    if (expectedBlock) {
      if (existsSync('AGENTS.md')) {
        const agentsContent = readFileSync('AGENTS.md', 'utf8');
        const isRigged =
          agentsContent.includes('<!-- AGENT-RIG:START -->') ||
          agentsContent.includes('<!-- AGENT-RIG:DOCS:START -->') ||
          isOwnRepo;
        if (isRigged) {
          const { block: currentDocsBlock, hasBlock } = extractManagedDocsBlock(agentsContent);
          if (!hasBlock || currentDocsBlock.trim() !== expectedBlock.trim()) {
            if (fix) {
              const { block: rulesBlock } = extractManagedAgentsBlock(agentsContent);
              const updated = mergeManagedAgentsFile(agentsContent, rulesBlock || '', '', expectedBlock);
              writeFileSync('AGENTS.md', updated, 'utf8');
              console.log('check-doc-links: updated documentation index in AGENTS.md');
              if (parsed.has('AGENTS.md')) {
                parsed.set('AGENTS.md', parseDoc('AGENTS.md', CFG));
              }
            } else {
              errors.push(
                'AGENTS.md: documentation index is missing or out of date — run `rig check-docs --fix` or `rig update` to refresh it',
              );
            }
          }
        }
      } else {
        if (isOwnRepo) {
          errors.push('AGENTS.md: missing in repository root — required for documentation index and agent conventions');
        }
      }
    }

    const colDirs = findCollectionDirs(path.join(targetRoot, 'docs'));
    for (const cDir of colDirs) {
      const relReadme = path.relative(targetRoot, path.join(cDir, 'README.md')).replace(/\\/g, '/');
      const readmePath = path.join(cDir, 'README.md');
      if (existsSync(readmePath)) {
        const expectedColBlock = buildCollectionDocsIndexBlock(cDir, targetRoot);
        const colContent = readFileSync(readmePath, 'utf8');
        const { block: currentColBlock, hasBlock: colHasBlock } = extractManagedDocsBlock(colContent);
        if (expectedColBlock) {
          if (!colHasBlock || currentColBlock.trim() !== expectedColBlock.trim()) {
            if (fix) {
              const updated = updateDocManagedDocsBlock(colContent, expectedColBlock);
              writeFileSync(readmePath, updated, 'utf8');
              console.log(`check-doc-links: updated documentation index in ${relReadme}`);
              const normRel = path.normalize(relReadme);
              parsed.set(normRel, parseDoc(normRel, CFG));
            } else {
              errors.push(
                `${relReadme}: documentation index is missing or out of date — run \`rig check-docs --fix\` or \`rig update\` to refresh it`,
              );
            }
          }
        }
      }
    }
  }

  function isCommitted(p) {
    if (!existsSync(p)) return false;
    if (isStealthRepo) {
      const r = spawnSync('git', ['check-ignore', '-q', p]);
      if (r.status === 0) return true;
    }
    if (!gitTracked || gitTracked.size === 0) return true;
    if (gitTracked.has(p)) return true;
    const prefix = p.endsWith(path.sep) ? p : p + path.sep;
    for (const t of gitTracked) if (t.startsWith(prefix)) return true;
    return false;
  }

  for (const [file, { links, bareRefs, repoPaths, externalUrls }] of parsed) {
    for (const { line, targetFile, fragment, raw, inManagedBlock } of links) {
      if (!existsSync(targetFile)) {
        if (inManagedBlock && !isOwnRepo) {
          continue;
        }
        errors.push(`${file}:${line}: broken link (${raw}) — ${targetFile} does not exist`);
        continue;
      }
      if (!isCommitted(targetFile)) {
        if (inManagedBlock && !isOwnRepo) {
          continue;
        }
        errors.push(`${file}:${line}: link target is untracked/gitignored (${raw}) — ${targetFile} is not in git`);
        continue;
      }
      if (fragment) {
        const targetSlugs = slugsFor(targetFile);
        if (targetSlugs && !targetSlugs.has(fragment.toLowerCase())) {
          errors.push(`${file}:${line}: broken anchor (${raw}) — #${fragment} not found in ${targetFile}`);
        }
      }
    }
    for (const { line, raw, reason } of bareRefs) {
      errors.push(`${file}:${line}: ${raw} — ${reason}`);
    }
    for (const { line, raw, targetPath, inManagedBlock } of repoPaths) {
      if (!existsSync(targetPath)) {
        if (inManagedBlock && !isOwnRepo) {
          continue;
        }
        const baseName = path.basename(targetPath);
        const dotIdx = baseName.lastIndexOf('.');
        if (dotIdx > 0) {
          const symbol = baseName.slice(dotIdx + 1);
          const candidateBase = path.join(path.dirname(targetPath), baseName.slice(0, dotIdx));
          if (
            !COMMON_EXTS.has(symbol.toLowerCase()) &&
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol) &&
            existsSync(candidateBase) &&
            isCommitted(candidateBase)
          ) {
            continue;
          }
        }
        errors.push(
          `${file}:${line}: ${raw} — ${targetPath} does not exist (strike through as ~~${raw}~~ if deliberately removed)`,
        );
      } else if (!isCommitted(targetPath)) {
        if (inManagedBlock && !isOwnRepo) {
          continue;
        }
        errors.push(`${file}:${line}: ${raw} — ${targetPath} is untracked/gitignored`);
      }
    }
    for (const { line, url, heading } of externalUrls) {
      if (/claude\.ai\/code\/artifact\//i.test(url)) {
        if (!heading || !/^(references|visual record)\b/i.test(heading)) {
          errors.push(
            `${file}:${line}: Artifact URL (${url}) in section "${heading ?? '(top)'}" — keep Artifact links in a trailing "## References" / "### Visual record" section only`,
          );
        }
      }
    }
  }

  const reachable = new Set();
  const queue = [...parsed.keys()].filter(isEntryPoint);
  for (const ep of queue) reachable.add(ep);

  while (queue.length > 0) {
    const cur = queue.shift();
    const doc = parsed.get(cur);
    if (!doc) continue;
    for (const { targetFile } of doc.links) {
      if (parsed.has(targetFile) && !reachable.has(targetFile)) {
        reachable.add(targetFile);
        queue.push(targetFile);
      }
    }
  }

  for (const file of parsed.keys()) {
    if (file === 'README.md') continue;
    if (!reachable.has(file)) {
      errors.push(`${file}: orphan — not reachable from AGENTS.md, CLAUDE.md, any SKILL.md, or rules/`);
    }
  }

  for (const file of parsed.keys()) {
    const bytes = statSync(file).size;
    if (file.startsWith(`docs${path.sep}epics${path.sep}`)) {
      if (bytes > CFG.epicMaxBytes) {
        errors.push(
          `${file}: ${bytes} B exceeds the ${CFG.epicMaxBytes} B epic-index cap — move durable contracts into an ADR and delete completed slice prose`,
        );
      }
      const text = readFileSync(file, 'utf8');
      if (!/delete this file/i.test(text)) {
        errors.push(`${file}: epic index must state its own deletion condition ("Delete this file when…")`);
      }
    }
    if (file.startsWith(`docs${path.sep}adr${path.sep}`)) {
      if (bytes > CFG.adrMaxBytes) {
        errors.push(
          `${file}: ${bytes} B exceeds the ${CFG.adrMaxBytes} B ADR cap — move chronological slice logs to docs/implementation-notes/`,
        );
      }
    }
  }

  const codeFiles = CFG.codeRoots.flatMap((r) => walkCode(r));
  const DOC_REF_RE = /\b((?:docs|skills|rules|\.claude|\.agents)\/[A-Za-z0-9_./*-]+?\.md)(?:#([A-Za-z0-9_-]+))?(?![A-Za-z0-9_/-])/g;

  for (const file of codeFiles) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/(?:\/\/|#|\/\*|\*|<!--|--)/.test(line)) continue;
      if (/check-doc-links:ignore/.test(line)) continue;
      for (const m of line.matchAll(DOC_REF_RE)) {
        const [raw, relPath, fragment] = m;
        if (/[*?]/.test(relPath)) {
          errors.push(`${file}:${i + 1}: comment cites glob path (${raw}) — name the specific file`);
          continue;
        }
        const targetFile = path.normalize(relPath);
        if (!existsSync(targetFile)) {
          errors.push(`${file}:${i + 1}: comment cites missing doc (${raw}) — ${targetFile} does not exist`);
          continue;
        }
        if (fragment) {
          const targetSlugs = slugsFor(targetFile);
          if (targetSlugs && !targetSlugs.has(fragment.toLowerCase())) {
            errors.push(`${file}:${i + 1}: comment cites broken anchor (${raw}) — #${fragment} not found in ${targetFile}`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error(`check-doc-links: ${errors.length} problem(s):\n`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }

  console.log(`check-doc-links: ${parsed.size} docs, all internal links resolve. OK.`);
}

function isMainScript() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainScript()) {
  runCli();
}
