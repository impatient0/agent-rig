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
//      a cold session actually starts from (README.md, AGENTS.md, CLAUDE.md,
//      GEMINI.md, a SKILL.md, or a rule under rules/ or .claude/rules/).
//   4. Every backticked path into the repo (`src/…`, `scripts/…`, `hooks/…`, etc.)
//      names a file that exists — or, when deliberately removed, is struck through:
//      ~~`scripts/gone.mjs`~~.
//   5. Published-Artifact links (claude.ai/code/artifact/...) appear only under a
//      trailing "References"/"Visual record" heading.
//   6. Code comments cite docs the same way docs do: a `docs/…md` path resolves,
//      a #fragment names a real heading, and glob paths are banned here too.
//
// Usage: node scripts/check-doc-links.mjs [target-dir]

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const targetRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
process.chdir(targetRoot);

const DEFAULTS = {
  docRoots: [
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    'docs',
    'skills',
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

const CFG = loadConfig();
const DOC_ROOTS = CFG.docRoots;

const isEntryPoint = (f) =>
  f === 'README.md' ||
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

function parseDoc(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const slugs = new Set();
  const slugCounts = new Map();
  const links = [];
  const bareRefs = [];
  const repoPaths = [];
  const externalUrls = [];

  const prefixAlt = CFG.repoPathPrefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const repoPathRe = new RegExp(`^(?:${prefixAlt})\\/\\S+$`);
  const docPrefixRe = /^(?:docs|skills|rules|\.claude|\.agents)\//;

  let inFence = false;
  let currentHeading = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
          links.push({ line: i + 1, targetFile: file, fragment: raw.slice(1), raw });
        }
        continue;
      }
      const [relPath, fragment = null] = raw.split('#');
      const targetFile = path.normalize(path.join(path.dirname(file), relPath));
      links.push({ line: i + 1, targetFile, fragment, raw });
    }

    for (const m of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
      bareRefs.push({ line: i + 1, raw: m[0], reason: '[[wiki-style]] link — use a relative Markdown link' });
    }

    const withoutLinks = line
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/~~`[^`]+`~~/g, '')
      .replace(/~~[^~]+~~/g, '');
    for (const m of withoutLinks.matchAll(/`([^`\n]+)`/g)) {
      const tok = m[1].trim();
      if (
        docPrefixRe.test(tok) &&
        (/[*?]/.test(tok) || /(?:^|\/)(?:[\w.-]+\.md|SKILL\.md)(?:#[\w-]+)?$/.test(tok))
      ) {
        const reason = /[*?]/.test(tok)
          ? 'glob path — link to the specific file'
          : 'bare backticked doc path — wrap in a Markdown link `[`…`](…)` (or strike through `~~`…`~~` if removed)';
        bareRefs.push({ line: i + 1, raw: `\`${tok}\``, reason });
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
        repoPaths.push({ line: i + 1, raw: `\`${tok}\``, targetPath: path.normalize(cleaned) });
      }
    }
  }

  return { slugs, links, bareRefs, repoPaths, externalUrls };
}

const files = DOC_ROOTS.flatMap((r) => walk(r));
const parsed = new Map(files.map((f) => [path.normalize(f), parseDoc(f)]));

function slugsFor(targetFile) {
  if (!parsed.has(targetFile) && existsSync(targetFile) && targetFile.endsWith('.md')) {
    parsed.set(targetFile, parseDoc(targetFile));
  }
  return parsed.get(targetFile)?.slugs;
}

const errors = [];

const gitTracked = (() => {
  const r = spawnSync('git', ['ls-files'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return new Set(r.stdout.split('\n').filter(Boolean).map(path.normalize));
})();

function isCommitted(p) {
  if (!existsSync(p)) return false;
  if (!gitTracked || gitTracked.size === 0) return true;
  if (gitTracked.has(p)) return true;
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  for (const t of gitTracked) if (t.startsWith(prefix)) return true;
  return false;
}

for (const [file, { links, bareRefs, repoPaths, externalUrls }] of parsed) {
  for (const { line, targetFile, fragment, raw } of links) {
    if (!existsSync(targetFile)) {
      errors.push(`${file}:${line}: broken link (${raw}) — ${targetFile} does not exist`);
      continue;
    }
    if (!isCommitted(targetFile)) {
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
  for (const { line, raw, targetPath } of repoPaths) {
    if (!existsSync(targetPath)) {
      errors.push(
        `${file}:${line}: ${raw} — ${targetPath} does not exist (strike through as ~~${raw}~~ if deliberately removed)`,
      );
    } else if (!isCommitted(targetPath)) {
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
  if (!reachable.has(file)) {
    errors.push(`${file}: orphan — not reachable from README.md, AGENTS.md, CLAUDE.md, any SKILL.md, or rules/`);
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
