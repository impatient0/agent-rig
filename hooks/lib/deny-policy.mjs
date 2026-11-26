import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { existingAncestor, resolveGitRoots } from './hook-io.mjs';

const RULE_SWITCH_RE = /^(!?)@([a-z0-9-]+:[a-z0-9-]+)$/i;
const DEFAULT_RIG_ROOT = path.resolve(import.meta.dirname, '..', '..');

function toPosix(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

function safeRealpath(p) {
  if (!p) return null;
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function escapeRegexChar(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Converts a single glob pattern (with `*`, `?`, `**`) into a RegExp body (without `^`/`$`).
 */
function globToRegexBody(glob) {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    if (glob[i] === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.+/)?';
        i += 3;
        continue;
      }
      out += '.*';
      i += 2;
      continue;
    }
    if (glob[i] === '*') {
      out += '[^/]*';
      i++;
      continue;
    }
    if (glob[i] === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    out += escapeRegexChar(glob[i]);
    i++;
  }
  return out;
}

/**
 * Compiles a path/directory glob rule into a matcher function.
 */
function compilePathRule(rawLine, negated, source) {
  let pattern = negated ? rawLine.slice(1) : rawLine;
  if (pattern.startsWith('\\!') || pattern.startsWith('\\#')) {
    pattern = pattern.slice(1);
  }
  pattern = pattern.replace(/\\/g, '/');
  if (!pattern) return null;

  // 1. Home-anchored pattern (`~/...`)
  if (pattern === '~' || pattern.startsWith('~/')) {
    const sub = pattern === '~' ? '' : pattern.slice(2);
    const dirOnly = sub.endsWith('/');
    const recursiveStar = !dirOnly && (sub === '**' || sub.endsWith('/**'));
    const clean = dirOnly ? sub.slice(0, -1) : recursiveStar ? sub.slice(0, -3) : sub;
    const exactRe = clean ? new RegExp(`^${globToRegexBody(clean)}$`) : null;
    const prefixRe = clean ? new RegExp(`^${globToRegexBody(clean)}/.+$`) : null;

    return {
      kind: 'path',
      negated,
      raw: rawLine,
      pattern,
      source,
      matches(ctx) {
        if (!ctx.relHome) return false;
        if (!clean) return true;
        if (dirOnly) {
          return (ctx.isDirectory && exactRe.test(ctx.relHome)) || prefixRe.test(ctx.relHome);
        }
        if (recursiveStar) {
          return (ctx.isDirectory && exactRe.test(ctx.relHome)) || prefixRe.test(ctx.relHome);
        }
        return exactRe.test(ctx.relHome);
      },
    };
  }

  const dirOnly = pattern.endsWith('/');
  const withoutTrailingSlash = dirOnly ? pattern.slice(0, -1) : pattern;
  const hasInternalSlash = withoutTrailingSlash.includes('/');

  // 2. Basename or any-depth directory-name pattern (no internal `/`)
  if (!hasInternalSlash) {
    const clean = withoutTrailingSlash;
    if (!clean) return null;
    const nameRe = new RegExp(`^${globToRegexBody(clean)}$`);

    return {
      kind: 'path',
      negated,
      raw: rawLine,
      pattern,
      source,
      matches(ctx) {
        if (dirOnly) {
          const segments = (ctx.relRepo ?? ctx.absPath).split('/').filter(Boolean);
          if (segments.length === 0) return false;
          const limit = ctx.isDirectory ? segments.length : segments.length - 1;
          for (let i = 0; i < limit; i++) {
            if (nameRe.test(segments[i])) return true;
          }
          return false;
        }
        if (nameRe.test(ctx.basename)) return true;
        if (!negated && ctx.relRepo) {
          const segments = ctx.relRepo.split('/').filter(Boolean);
          for (let i = 0; i < segments.length - 1; i++) {
            if (nameRe.test(segments[i])) return true;
          }
        }
        return false;
      },
    };
  }

  // 3. Repo-relative path glob (contains `/` other than trailing `/`)
  const anchored = withoutTrailingSlash.startsWith('/') ? withoutTrailingSlash.slice(1) : withoutTrailingSlash;
  const recursiveStar = !dirOnly && (anchored === '**' || anchored.endsWith('/**'));
  const clean = recursiveStar ? (anchored === '**' ? '' : anchored.slice(0, -3)) : anchored;
  const exactRe = clean ? new RegExp(`^${globToRegexBody(clean)}$`) : null;
  const prefixRe = clean ? new RegExp(`^${globToRegexBody(clean)}/.+$`) : null;

  return {
    kind: 'path',
    negated,
    raw: rawLine,
    pattern,
    source,
    matches(ctx) {
      for (const rel of ctx.repoCandidates) {
        if (!clean) return true;
        if (dirOnly || recursiveStar) {
          if ((ctx.isDirectory && exactRe.test(rel)) || prefixRe.test(rel)) {
            return true;
          }
        } else if (exactRe.test(rel)) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Locates `templates/deny.default` across explicit rigRoot, repo `.rig/templates/`, or bundled source tree.
 */
function resolveDefaultsTemplatePath({ rigRoot, topLevel, repoRoot }) {
  const candidates = [];
  if (rigRoot) {
    candidates.push(path.join(rigRoot, 'templates', 'deny.default'));
    candidates.push(path.join(rigRoot, '.rig', 'templates', 'deny.default'));
  }
  if (topLevel) {
    candidates.push(path.join(topLevel, '.rig', 'templates', 'deny.default'));
  }
  if (repoRoot && repoRoot !== topLevel) {
    candidates.push(path.join(repoRoot, '.rig', 'templates', 'deny.default'));
  }
  candidates.push(path.resolve(DEFAULT_RIG_ROOT, 'templates', 'deny.default'));
  candidates.push(path.resolve(DEFAULT_RIG_ROOT, '.rig', 'templates', 'deny.default'));
  candidates.push(path.resolve(import.meta.dirname, '..', '..', '..', '.rig', 'templates', 'deny.default'));

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readRuleLines(filePath) {
  try {
    return readFileSync(filePath, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

function parseLinesIntoRules(lines, source, defaultsLines, outRules, outSwitches, { allowDefaults = true } = {}) {
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed === '@defaults') {
      if (allowDefaults && Array.isArray(defaultsLines)) {
        parseLinesIntoRules(defaultsLines, '@defaults', null, outRules, outSwitches, { allowDefaults: false });
      }
      continue;
    }

    const switchMatch = RULE_SWITCH_RE.exec(trimmed);
    if (switchMatch) {
      const negated = switchMatch[1] === '!';
      const id = switchMatch[2].toLowerCase();
      outSwitches.set(id, !negated);
      outRules.push({
        kind: 'rule',
        negated,
        id,
        raw: trimmed,
        source,
      });
      continue;
    }

    const negated = trimmed.startsWith('!');
    const compiled = compilePathRule(trimmed, negated, source);
    if (compiled) {
      outRules.push(compiled);
    }
  }
}

/**
 * Loads the effective `.rig/deny` policy for `cwd` (governed by docs/adr/0006-configurable-deny-policy-and-secops-guards.md).
 *
 * Resolution order:
 * 1. Resolve `topLevel` and `repoRoot` via `resolveGitRoots`.
 * 2. Use `<topLevel>/.rig/deny` when `topLevel !== repoRoot` and it exists; otherwise `<repoRoot>/.rig/deny`.
 *    If neither exists, evaluate `@defaults`. If `.rig/deny` exists without `@defaults`, start from a blank slate.
 * 3. Append `<repoRoot>/.rig/deny.local` and `<topLevel>/.rig/deny.local` (when present and distinct) last.
 */
export function loadDenyPolicy({
  cwd = process.cwd(),
  homeDir = homedir(),
  rigRoot = DEFAULT_RIG_ROOT,
} = {}) {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const ancestor = existingAncestor(resolvedCwd, resolvedCwd) || resolvedCwd;
  const roots = resolveGitRoots(ancestor);

  let topLevel = roots?.topLevel ?? null;
  let repoRoot = roots?.repoRoot ?? null;
  if (!roots) {
    let cur = ancestor;
    while (cur) {
      if (existsSync(path.join(cur, '.rig', 'deny')) || existsSync(path.join(cur, '.rig'))) {
        topLevel = cur;
        repoRoot = cur;
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  const topDeny = topLevel ? path.join(topLevel, '.rig', 'deny') : null;
  const repoDeny = repoRoot ? path.join(repoRoot, '.rig', 'deny') : null;
  const topLocal = topLevel ? path.join(topLevel, '.rig', 'deny.local') : null;
  const repoLocal = repoRoot ? path.join(repoRoot, '.rig', 'deny.local') : null;

  let primaryDenyFile = null;
  if (topDeny && repoDeny && path.resolve(topDeny) !== path.resolve(repoDeny)) {
    if (existsSync(topDeny)) primaryDenyFile = topDeny;
    else if (existsSync(repoDeny)) primaryDenyFile = repoDeny;
  } else if (repoDeny && existsSync(repoDeny)) {
    primaryDenyFile = repoDeny;
  } else if (topDeny && existsSync(topDeny)) {
    primaryDenyFile = topDeny;
  }

  const defaultsPath = resolveDefaultsTemplatePath({ rigRoot, topLevel, repoRoot });
  const defaultsLines = defaultsPath ? readRuleLines(defaultsPath) : [];

  const rules = [];
  const enabledRules = new Map();
  const files = [];

  if (primaryDenyFile) {
    files.push(primaryDenyFile);
    parseLinesIntoRules(readRuleLines(primaryDenyFile), primaryDenyFile, defaultsLines, rules, enabledRules);
  } else {
    parseLinesIntoRules(['@defaults'], '@defaults', defaultsLines, rules, enabledRules);
  }

  if (repoLocal && existsSync(repoLocal)) {
    files.push(repoLocal);
    parseLinesIntoRules(readRuleLines(repoLocal), repoLocal, defaultsLines, rules, enabledRules);
  }
  if (topLocal && existsSync(topLocal) && (!repoLocal || path.resolve(topLocal) !== path.resolve(repoLocal))) {
    files.push(topLocal);
    parseLinesIntoRules(readRuleLines(topLocal), topLocal, defaultsLines, rules, enabledRules);
  }

  const normHome = toPosix(path.resolve(homeDir || homedir()));
  const realHome = toPosix(safeRealpath(normHome));
  const normTop = topLevel ? toPosix(path.resolve(topLevel)) : null;
  const realTop = normTop ? toPosix(safeRealpath(normTop)) : null;
  const normRepo = repoRoot ? toPosix(path.resolve(repoRoot)) : null;
  const realRepo = normRepo ? toPosix(safeRealpath(normRepo)) : null;

  return {
    cwd: resolvedCwd,
    topLevel: normTop,
    repoRoot: normRepo,
    homeDir: normHome,
    realHome,
    realTop,
    realRepo,
    defaultsPath,
    files,
    rules,
    pathRules: rules.filter((r) => r.kind === 'path'),
    enabledRules,
  };
}

function relativeInside(rootPosix, targetPosix) {
  if (!rootPosix) return null;
  if (targetPosix === rootPosix) return '';
  const prefix = rootPosix === '/' ? '/' : `${rootPosix}/`;
  if (targetPosix.startsWith(prefix)) {
    return targetPosix.slice(prefix.length);
  }
  return null;
}

function evaluateSingleAbsPath(policy, absPosix, isDirectory, { useRealRoots = false } = {}) {
  const homeBase = useRealRoots ? policy.realHome : policy.homeDir;
  const topBase = useRealRoots ? policy.realTop : policy.topLevel;
  const repoBase = useRealRoots ? policy.realRepo : policy.repoRoot;

  const relHome = relativeInside(homeBase, absPosix);
  const relTop = relativeInside(topBase, absPosix);
  const relRepoOnly = relativeInside(repoBase, absPosix);

  const repoCandidates = [];
  if (relTop) repoCandidates.push(relTop);
  if (relRepoOnly && relRepoOnly !== relTop) repoCandidates.push(relRepoOnly);

  const ctx = {
    absPath: absPosix,
    basename: path.posix.basename(absPosix),
    isDirectory,
    relHome,
    relRepo: relTop ?? relRepoOnly ?? null,
    repoCandidates,
  };

  let denied = false;
  let matchedRule = null;
  for (const rule of policy.pathRules) {
    if (rule.matches(ctx)) {
      denied = !rule.negated;
      matchedRule = rule;
    }
  }

  return {
    denied,
    matchedRule: matchedRule ? matchedRule.raw : null,
    pattern: matchedRule ? matchedRule.pattern : null,
    source: matchedRule ? matchedRule.source : null,
  };
}

function resolveTargetInput(policy, targetPath, cwd) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return null;
  let trimmed = targetPath.trim();
  if (trimmed === '~') {
    return policy.homeDir;
  }
  if (trimmed.startsWith('~/')) {
    return path.resolve(policy.homeDir, trimmed.slice(2));
  }
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd || policy.cwd, trimmed);
}

/**
 * Evaluates a file or directory path against the loaded policy (last matching rule wins).
 */
export function evaluatePath(policy, targetPath, { cwd, isDirectory } = {}) {
  const effectivePolicy = policy && Array.isArray(policy.pathRules) ? policy : loadDenyPolicy({ cwd });
  const abs = resolveTargetInput(effectivePolicy, targetPath, cwd);
  if (!abs) {
    return { denied: false, matchedRule: null, pattern: null, source: null };
  }

  let dirFlag = typeof isDirectory === 'boolean' ? isDirectory : false;
  if (typeof isDirectory !== 'boolean') {
    try {
      dirFlag = statSync(abs).isDirectory();
    } catch {
      dirFlag = targetPath.trim().endsWith('/') || targetPath.trim().endsWith('\\');
    }
  }

  const absPosix = toPosix(abs);
  const logicalRes = evaluateSingleAbsPath(effectivePolicy, absPosix, dirFlag, { useRealRoots: false });
  if (logicalRes.denied) return logicalRes;

  if (existsSync(abs)) {
    const real = safeRealpath(abs);
    const realPosix = toPosix(real);
    if (realPosix !== absPosix) {
      const realRes = evaluateSingleAbsPath(effectivePolicy, realPosix, dirFlag, { useRealRoots: true });
      if (realRes.denied) return realRes;
    }
  }

  return logicalRes;
}

/**
 * Returns true if `targetPath` is denied by `policy`.
 */
export function isPathDenied(policy, targetPath, options = {}) {
  return evaluatePath(policy, targetPath, options).denied;
}

/**
 * Returns true if the named rule switch (`@category:id` or `category:id`) is enabled in `policy`.
 */
export function isRuleEnabled(policy, ruleId) {
  if (!policy || !policy.enabledRules || typeof ruleId !== 'string') return false;
  const normalized = ruleId.trim().replace(/^@/, '').toLowerCase();
  return policy.enabledRules.get(normalized) === true;
}

function expandSimpleBraces(glob) {
  const m = /\{([^{}]+)\}/.exec(glob);
  if (!m) return [glob];
  const prefix = glob.slice(0, m.index);
  const suffix = glob.slice(m.index + m[0].length);
  const out = [];
  for (const alt of m[1].split(',')) {
    out.push(...expandSimpleBraces(`${prefix}${alt}${suffix}`));
  }
  return out;
}

/**
 * Checks whether a search tool `glob` / `Includes` filter targets denied secret patterns.
 */
export function isSearchGlobDenied(policy, globPattern) {
  if (typeof globPattern !== 'string') return false;
  const trimmed = globPattern.trim();
  if (!trimmed || trimmed.startsWith('!')) return false;

  const effectivePolicy = policy && Array.isArray(policy.pathRules) ? policy : loadDenyPolicy();
  const baseRoot = effectivePolicy.topLevel || effectivePolicy.repoRoot || effectivePolicy.cwd;

  for (const variant of expandSimpleBraces(trimmed)) {
    let g = variant.replace(/\\/g, '/').trim();
    if (!g) continue;
    if (g.startsWith('**/')) g = g.slice(3);
    if (g.startsWith('./')) g = g.slice(2);

    const hasHome = g === '~' || g.startsWith('~/');
    const samples = [
      g.replace(/\*\*/g, 'dir').replace(/\*/g, 'x').replace(/\?/g, 'x'),
      g.replace(/\*\*/g, 'dir').replace(/\*/g, '').replace(/\?/g, 'x'),
    ];

    for (const sample of samples) {
      if (!sample || sample === 'x' || sample === 'dir/x') continue;
      const isDir = sample.endsWith('/');
      const cleanSample = isDir ? sample.slice(0, -1) : sample;
      if (!cleanSample) continue;
      const target = hasHome ? cleanSample : path.posix.join(toPosix(baseRoot), cleanSample);
      if (evaluatePath(effectivePolicy, target, { isDirectory: isDir }).denied) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns true if `targetPath` resolves to `.rig/deny` or `.rig/deny.local`.
 */
export function isDenyPolicyFile(targetPath, { cwd = process.cwd() } = {}) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return false;
  const abs = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(cwd, targetPath);
  const candidates = [abs];
  if (existsSync(abs)) {
    const real = safeRealpath(abs);
    if (real && real !== abs) candidates.push(real);
  } else {
    const parent = path.dirname(abs);
    if (existsSync(parent)) {
      const realParent = safeRealpath(parent);
      if (realParent && realParent !== parent) {
        candidates.push(path.join(realParent, path.basename(abs)));
      }
    }
  }
  return candidates.some((p) => {
    const base = path.basename(p);
    const parentBase = path.basename(path.dirname(p));
    return parentBase === '.rig' && (base === 'deny' || base === 'deny.local');
  });
}
