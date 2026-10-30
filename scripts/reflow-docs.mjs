#!/usr/bin/env node
// Normalizes every committed Markdown doc to **one sentence per line**.
//
// Usage:
//   node scripts/reflow-docs.mjs [target-dir]           rewrite every doc in place
//   node scripts/reflow-docs.mjs [target-dir] --check   exit 1 if any doc is not canonical

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const dirArg = args.find((a) => !a.startsWith('-'));
if (dirArg) {
  process.chdir(path.resolve(dirArg));
}

const DEFAULT_DOC_ROOTS = [
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
  'templates',
];

function loadDocRoots() {
  if (existsSync('.doclinksrc.json')) {
    try {
      const cfg = JSON.parse(readFileSync('.doclinksrc.json', 'utf8'));
      if (Array.isArray(cfg.docRoots)) return cfg.docRoots;
    } catch {
      // Fall back to defaults on invalid config
    }
  }
  return DEFAULT_DOC_ROOTS;
}

const ABBREVIATIONS = ['e.g.', 'i.e.', 'cf.', 'vs.', 'etc.', 'Dr.', 'Mr.', 'Ms.', 'St.', 'approx.'];

function walk(target, out = []) {
  if (!existsSync(target)) return out;
  if (statSync(target).isFile()) {
    if (target.endsWith('.md')) out.push(target);
    return out;
  }
  for (const entry of readdirSync(target)) walk(path.join(target, entry), out);
  return out;
}

function isStructural(line) {
  return (
    line.trim() === '' ||
    /^\s*#{1,6}\s/.test(line) ||
    /^\s*\|/.test(line) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    /^\s*```/.test(line)
  );
}

function listMarker(line) {
  const m = /^(\s*)([-*]|\d+\.)\s+/.exec(line);
  return m ? { indent: m[1], continuation: ' '.repeat(m[0].length) } : null;
}

function insideEmphasis(text) {
  const bare = text.replace(/`[^`]*`/g, '');
  const bold = (bare.match(/\*\*/g) ?? []).length;
  const under = (bare.match(/(?<!\w)_|_(?!\w)/g) ?? []).length;
  return bold % 2 !== 0 || under % 2 !== 0;
}

export function splitSentences(text) {
  const out = [];
  let start = 0;
  let depth = 0;
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '`') inCode = !inCode;
    if (inCode) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth > 0) continue;

    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== ':' && ch !== ';') continue;

    let end = i + 1;
    while (end < text.length && (text[end] === '"' || text[end] === "'" || text[end] === ')' || text[end] === '*')) {
      if (text[end] === ')' && depth === 0) break;
      end++;
    }
    if (end >= text.length || text[end] !== ' ') continue;

    const slice = text.slice(start, end);
    if (ch === '.' && ABBREVIATIONS.some((a) => slice.endsWith(a))) continue;
    if (ch === '.' && /(?:^|\s)\d+\.$/.test(slice)) continue;
    if (insideEmphasis(slice)) continue;

    let next = end;
    while (next < text.length && text[next] === ' ') next++;
    if (next >= text.length) continue;

    if (ch === ':' || ch === ';') {
      const lead = slice.replace(/^\s*(?:[-*]|\d+\.)\s+/, '');
      if (ch === ':' && (/^\*\*[^*]+\*\*:\s*$/.test(lead) || /^[A-Za-z][A-Za-z0-9 _-]{0,25}:\s*$/.test(lead))) {
        continue;
      }
      out.push(slice);
      start = next;
      i = next - 1;
      continue;
    }

    if (!/[A-Z0-9"`[(\p{Emoji_Presentation}]/u.test(text[next])) continue;

    out.push(slice);
    start = next;
    i = next - 1;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export function reflowBlock(lines) {
  const first = lines[0];
  const lm = listMarker(first);
  const bq = /^(\s*>\s?)/.exec(first);

  let prefix1;
  let prefixN;
  let bodies;
  if (lm) {
    const markerLen = lm.continuation.length;
    prefix1 = first.slice(0, markerLen);
    prefixN = lm.continuation;
    bodies = [first.slice(markerLen).trim(), ...lines.slice(1).map((l) => l.trim())];
  } else if (bq) {
    prefix1 = bq[1];
    prefixN = bq[1];
    bodies = lines.map((l) => l.replace(/^\s*>\s?/, '').trim());
  } else {
    const indent = /^(\s*)/.exec(first)[1];
    prefix1 = indent;
    prefixN = indent;
    bodies = lines.map((l) => l.trim());
  }

  const joined = bodies.join(' ').replace(/\s+/g, ' ').trim();
  const sentences = splitSentences(joined);
  return sentences.map((s, idx) => (idx === 0 ? prefix1 : prefixN) + s);
}

export function reflowMarkdown(src) {
  const lines = src.split('\n');
  const out = [];
  let inFence = false;
  let inFrontmatter = false;
  let buf = [];
  let bufKind = null;

  const flush = () => {
    if (buf.length === 0) return;
    out.push(...reflowBlock(buf));
    buf = [];
    bufKind = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (i === 0 && line.trim() === '---') {
      inFrontmatter = true;
      out.push(line);
      continue;
    }
    if (inFrontmatter) {
      out.push(line);
      if (line.trim() === '---') inFrontmatter = false;
      continue;
    }

    if (/^\s*```/.test(line)) {
      flush();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    if (isStructural(line)) {
      flush();
      out.push(line);
      continue;
    }

    const lm = listMarker(line);
    const bq = /^\s*>/.test(line);

    if (lm) {
      flush();
      buf.push(line);
      bufKind = { type: 'list', indent: lm.continuation.length };
      continue;
    }

    if (bq) {
      if (bufKind?.type !== 'quote') flush();
      buf.push(line);
      bufKind = { type: 'quote' };
      continue;
    }

    if (bufKind?.type === 'list') {
      const leadSpaces = /^(\s*)/.exec(line)[1].length;
      if (leadSpaces >= 2) {
        buf.push(line);
        continue;
      }
      flush();
    } else if (bufKind?.type === 'quote') {
      flush();
    }

    const prev = buf[buf.length - 1];
    if (prev && /\\\s*$/.test(prev)) {
      flush();
    }

    buf.push(line);
    bufKind = { type: 'para' };
  }
  flush();
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = loadDocRoots().flatMap((r) => walk(r));
  const dirty = [];

  for (const f of files) {
    const before = readFileSync(f, 'utf8');
    const after = reflowMarkdown(before);
    if (after !== before) {
      dirty.push(f);
      if (!checkOnly) writeFileSync(f, after);
    }
  }

  if (checkOnly && dirty.length > 0) {
    console.error(`check-doc-format: these docs are not in canonical form (one sentence per line):\n`);
    for (const f of dirty) console.error(`  ${f}`);
    console.error(`\nRun: node scripts/reflow-docs.mjs`);
    process.exit(1);
  }

  console.log(
    checkOnly
      ? `check-doc-format: ${files.length} docs, all one sentence per line. OK.`
      : `reflow-docs: ${dirty.length} of ${files.length} docs rewritten.`,
  );
}
