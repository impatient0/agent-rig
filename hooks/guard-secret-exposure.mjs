#!/usr/bin/env node
// PreToolUse secret-exposure guard (`read_file`/`view_file`/`view_file_outline`/
// `view_code_item`/`grep_search`/`edit_file`/`write_file`/`run_command` in Antigravity,
// `Read`/`Grep`/`Edit`/`Write`/`Bash` in Claude Code): blocks accidental secret reads,
// stdout secret leaks, CLI credential dumps, and agent tampering with `.rig/deny`.

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readHookInput,
  emitDecision,
  existingAncestor,
  isDirectoryInRiggedRepo,
} from './lib/hook-io.mjs';
import {
  loadDenyPolicy,
  evaluatePath,
  isSearchGlobDenied,
  isRuleEnabled,
  isDenyPolicyFile,
} from './lib/deny-policy.mjs';
import {
  stripHeredocs,
  stripWrappers,
  parseCdSegment,
  parseNestedCommand,
  extractSubshells,
  parseCommandLists,
  ASSIGN_RE,
} from './lib/shell-parser.mjs';

const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const SOPS_FILENAME_RE = /\.(?:sops|enc)\.[^/]+$/i;
const NPMRC_AUTH_RE = /_authToken|_auth=|_password/;
const SECRET_VAR_NAME_RE =
  /(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|AGE_KEY|AUTH|CREDENTIALS?)/i;

const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'Edit', 'Write']);
const SEARCH_TOOLS = new Set(['grep_search', 'Grep']);

const STDOUT_FILE_READERS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'batcat',
  'nl',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'sed',
  'awk',
  'gawk',
  'mawk',
  'cut',
  'strings',
  'base64',
  'xxd',
  'hexdump',
  'od',
  'jq',
  'yq',
]);

const TEXT_PRINTER_SINKS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'batcat',
  'nl',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'sed',
  'awk',
  'gawk',
  'mawk',
  'cut',
  'jq',
  'yq',
  'tee',
  'strings',
  'base64',
  'xxd',
  'hexdump',
  'od',
]);

function resolvePathInput(targetPath, cwd, homeDir) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return null;
  const trimmed = targetPath.trim();
  if (trimmed === '~') return path.resolve(homeDir);
  if (trimmed.startsWith('~/')) return path.resolve(homeDir, trimmed.slice(2));
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed);
}

function isTargetInRiggedRepo(targetPath, cwd, homeDir) {
  const abs = resolvePathInput(targetPath, cwd, homeDir);
  if (!abs) return false;
  return isDirectoryInRiggedRepo(abs, cwd);
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function toPosix(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
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

function readFilePrefixSafe(absPath, maxBytes = 512 * 1024) {
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size === 0) return '';
  try {
    if (stat.size <= maxBytes) {
      return readFileSync(absPath, 'utf8');
    }
    const fd = openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
      return buf.toString('utf8', 0, bytesRead);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function buildAntiTamperReason(targetPath, cwd) {
  const abs = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(cwd, targetPath);
  const policyLabel = path.basename(abs) === 'deny.local' ? '.rig/deny.local' : '.rig/deny';
  return (
    `Refusing to modify \`${policyLabel}\`: \`.rig/deny\` and \`.rig/deny.local\` are protected against agent edits ` +
    'and may only be edited directly by the user in their editor or terminal.'
  );
}

function checkContentRules(policy, targetPath, { cwd, homeDir }) {
  const abs = resolvePathInput(targetPath, cwd, homeDir);
  if (!abs || !existsSync(abs)) return null;

  const content = readFilePrefixSafe(abs);
  if (content === null) return null;

  const real = safeRealpath(abs);
  const base = path.basename(abs);
  const realBase = path.basename(real);

  if (isRuleEnabled(policy, 'content:private-key') && PRIVATE_KEY_RE.test(content)) {
    return {
      decision: 'deny',
      reason:
        `Refusing to read/inspect \`${targetPath}\`: file contains a private key header (\`@content:private-key\`). ` +
        'Use public keys/certificates or follow `skills/secure-credential-handoff/SKILL.md`.',
    };
  }

  if (
    isRuleEnabled(policy, 'content:unencrypted-sops') &&
    (SOPS_FILENAME_RE.test(base) || SOPS_FILENAME_RE.test(realBase))
  ) {
    if (content.trim().length > 0 && !content.includes('ENC[') && !content.includes('$ANSIBLE_VAULT;')) {
      return {
        decision: 'deny',
        reason:
          `Refusing to read/inspect \`${targetPath}\`: file matches \`*.sops.*\`/\`*.enc.*\` without SOPS (\`ENC[\`) ` +
          'or `$ANSIBLE_VAULT;` ciphertext markers (`@content:unencrypted-sops`). Encrypt it or follow `skills/secure-credential-handoff/SKILL.md`.',
      };
    }
  }

  if (isRuleEnabled(policy, 'content:npmrc-auth') && (base === '.npmrc' || realBase === '.npmrc')) {
    if (NPMRC_AUTH_RE.test(content)) {
      return {
        decision: 'deny',
        reason:
          `Refusing to read/inspect \`${targetPath}\`: \`.npmrc\` contains authentication credentials (\`@content:npmrc-auth\`). ` +
          'See `skills/secure-credential-handoff/SKILL.md`.',
      };
    }
  }

  return null;
}

function checkPathReadTarget(policy, targetPath, { cwd, homeDir }) {
  const evalRes = evaluatePath(policy, targetPath, { cwd });
  if (evalRes.denied) {
    return {
      decision: 'deny',
      reason:
        `Refusing to read secret-protected path \`${targetPath}\` (matched rule \`${evalRes.matchedRule}\`). ` +
        'See `skills/secure-credential-handoff/SKILL.md` for zero-stdout `grep -q \'^VAR=\'` checks, ' +
        '`sops exec-env` / `sops exec-file`, or user-managed `.env.local` handoff.',
    };
  }
  return checkContentRules(policy, targetPath, { cwd, homeDir });
}

function isSearchDirContainingHomeSecrets(policy, absDir) {
  let isDir = false;
  try {
    isDir = statSync(absDir).isDirectory();
  } catch {
    return false;
  }
  if (!isDir) return false;

  const absPosix = toPosix(absDir);
  const realPosix = toPosix(safeRealpath(absDir));

  // Allow searches rooted inside the repository itself unless denied by evaluatePath.
  const inRepo =
    relativeInside(policy.topLevel, absPosix) !== null ||
    relativeInside(policy.repoRoot, absPosix) !== null ||
    relativeInside(policy.realTop, realPosix) !== null ||
    relativeInside(policy.realRepo, realPosix) !== null;

  const relHome = relativeInside(policy.homeDir, absPosix) ?? relativeInside(policy.realHome, realPosix);
  if (relHome === null) return false;
  if (inRepo && relHome !== '') return false;

  // Track whether any active home-anchored rule resides under `absDir`.
  const activeHomeSubtrees = new Set();
  for (const rule of policy.pathRules) {
    if (typeof rule.pattern !== 'string' || !rule.pattern.startsWith('~/')) continue;
    const sub = rule.pattern.slice(2);
    if (!rule.negated) {
      activeHomeSubtrees.add(sub);
    } else {
      const cleanNeg = sub.replace(/\/\*\*$/, '').replace(/\/$/, '');
      for (const existing of [...activeHomeSubtrees]) {
        if (existing === sub || existing === cleanNeg || existing.startsWith(`${cleanNeg}/`)) {
          activeHomeSubtrees.delete(existing);
        }
      }
    }
  }

  if (activeHomeSubtrees.size === 0) return false;
  if (relHome === '') return true;

  const prefix = `${relHome}/`;
  for (const sub of activeHomeSubtrees) {
    if (sub === relHome || sub.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function evaluateSearchTool(policy, searchPath, searchGlobs, { cwd, homeDir }) {
  for (const glob of searchGlobs ?? []) {
    if (isSearchGlobDenied(policy, glob)) {
      return {
        decision: 'deny',
        reason:
          `Refusing search glob \`${glob}\`: filter targets secret-protected files. ` +
          'See `skills/secure-credential-handoff/SKILL.md`.',
      };
    }
  }

  const effectiveSearchPath = searchPath || cwd;
  if (effectiveSearchPath) {
    const evalRes = evaluatePath(policy, effectiveSearchPath, { cwd });
    if (evalRes.denied) {
      return {
        decision: 'deny',
        reason:
          `Refusing to search secret-protected path \`${effectiveSearchPath}\` (matched rule \`${evalRes.matchedRule}\`). ` +
          'See `skills/secure-credential-handoff/SKILL.md`.',
      };
    }

    const abs = resolvePathInput(effectiveSearchPath, cwd, homeDir);
    if (abs) {
      if (isSearchDirContainingHomeSecrets(policy, abs)) {
        return {
          decision: 'deny',
          reason:
            `Refusing to search host directory \`${effectiveSearchPath}\` containing secret-protected paths. ` +
            'See `skills/secure-credential-handoff/SKILL.md`.',
        };
      }
      const contentRes = checkContentRules(policy, effectiveSearchPath, { cwd, homeDir });
      if (contentRes) return contentRes;
    }
  }

  return { decision: 'allow', reason: null };
}

function unwrapEnvCommand(tokens, { bin, rest, wrappers }) {
  if (!Array.isArray(wrappers) || !wrappers.includes('env')) {
    return { bin, rest, isBareEnvDump: false };
  }

  const afterEnv = [];
  if (bin) afterEnv.push(bin, ...rest);

  const ENV_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '-a', '--argv0']);
  let i = 0;
  let sawHelpOrVersion = false;
  while (i < afterEnv.length) {
    const tok = afterEnv[i];
    if (tok === '--') {
      i++;
      break;
    }
    if (tok === '--help' || tok === '--version') {
      sawHelpOrVersion = true;
      i++;
      continue;
    }
    if (tok.startsWith('--unset=') || tok.startsWith('--chdir=') || tok.startsWith('--split-string=') || tok.startsWith('--argv0=')) {
      i++;
      continue;
    }
    if (ENV_VALUE_FLAGS.has(tok)) {
      i += 2;
      continue;
    }
    if (tok.startsWith('-') && tok !== '-') {
      i++;
      continue;
    }
    if (ASSIGN_RE.test(tok)) {
      i++;
      continue;
    }
    break;
  }

  if (i >= afterEnv.length) {
    return { bin: null, rest: [], isBareEnvDump: !sawHelpOrVersion };
  }

  const inner = stripWrappers(afterEnv.slice(i));
  return { bin: inner.bin, rest: inner.rest, isBareEnvDump: false };
}

function extractPositionalArgs(args, valueFlags = new Set()) {
  const positional = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!afterDoubleDash && tok === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && tok.startsWith('-') && tok !== '-') {
      if (!tok.includes('=') && valueFlags.has(tok) && i + 1 < args.length) {
        i++;
      }
      continue;
    }
    positional.push(tok);
  }
  return positional;
}

function checkStageAntiTamper(stage, bin, rest, activeCwd) {
  for (const r of stage.redirections) {
    if (r.isOutput && r.target && isDenyPolicyFile(r.target, { cwd: activeCwd })) {
      return buildAntiTamperReason(r.target, activeCwd);
    }
  }

  if (!bin) return null;

  if (bin === 'tee') {
    const args = extractPositionalArgs(rest);
    for (const a of args) {
      if (isDenyPolicyFile(a, { cwd: activeCwd })) {
        return buildAntiTamperReason(a, activeCwd);
      }
    }
    return null;
  }

  if (bin === 'rm' || bin === 'unlink' || bin === 'shred' || bin === 'touch' || bin === 'chmod' || bin === 'chown' || bin === 'sponge') {
    const valueFlags = new Set(['-n', '--iterations', '-s', '--size', '-d', '--date', '-t', '-r', '--reference', '--from']);
    const args = extractPositionalArgs(rest, valueFlags);
    for (const a of args) {
      if (isDenyPolicyFile(a, { cwd: activeCwd })) {
        return buildAntiTamperReason(a, activeCwd);
      }
    }
    return null;
  }

  if (bin === 'truncate') {
    const args = extractPositionalArgs(rest, new Set(['-s', '--size', '-r', '--reference']));
    for (const a of args) {
      if (isDenyPolicyFile(a, { cwd: activeCwd })) {
        return buildAntiTamperReason(a, activeCwd);
      }
    }
    return null;
  }

  if (bin === 'dd') {
    for (const tok of rest) {
      if (tok.startsWith('of=')) {
        const target = tok.slice(3);
        if (isDenyPolicyFile(target, { cwd: activeCwd })) {
          return buildAntiTamperReason(target, activeCwd);
        }
      }
    }
    return null;
  }

  if (bin === 'mv' || bin === 'cp' || bin === 'ln' || bin === 'install') {
    let targetDir = null;
    const positional = [];
    let afterDoubleDash = false;
    const valueFlags = new Set(['-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group']);
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (!afterDoubleDash && tok === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && (tok === '-t' || tok === '--target-directory') && i + 1 < rest.length) {
        targetDir = rest[++i];
        continue;
      }
      if (!afterDoubleDash && tok.startsWith('--target-directory=')) {
        targetDir = tok.slice('--target-directory='.length);
        continue;
      }
      if (!afterDoubleDash && tok.startsWith('-') && tok !== '-') {
        if (!tok.includes('=') && valueFlags.has(tok) && i + 1 < rest.length) i++;
        continue;
      }
      positional.push(tok);
    }

    if (targetDir) {
      for (const src of positional) {
        const dest = path.join(targetDir, path.basename(src));
        if (isDenyPolicyFile(dest, { cwd: activeCwd })) {
          return buildAntiTamperReason(dest, activeCwd);
        }
      }
    }

    if (bin === 'mv') {
      for (const arg of positional) {
        if (isDenyPolicyFile(arg, { cwd: activeCwd })) {
          return buildAntiTamperReason(arg, activeCwd);
        }
      }
    }

    if (positional.length >= 2) {
      const last = positional[positional.length - 1];
      if (isDenyPolicyFile(last, { cwd: activeCwd })) {
        return buildAntiTamperReason(last, activeCwd);
      }
      for (let idx = 0; idx < positional.length - 1; idx++) {
        const joined = path.join(last, path.basename(positional[idx]));
        if (isDenyPolicyFile(joined, { cwd: activeCwd })) {
          return buildAntiTamperReason(joined, activeCwd);
        }
      }
    } else if (positional.length === 1 && isDenyPolicyFile(positional[0], { cwd: activeCwd })) {
      return buildAntiTamperReason(positional[0], activeCwd);
    }
    return null;
  }

  if (bin === 'sed') {
    let inPlace = false;
    let hasExplicitScript = false;
    const positional = [];
    let afterDoubleDash = false;
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (!afterDoubleDash && tok === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && tok.startsWith('-') && tok !== '-') {
        if (tok === '--in-place' || tok.startsWith('--in-place=')) {
          inPlace = true;
          continue;
        }
        if (tok === '-e' || tok === '--expression' || tok === '-f' || tok === '--file') {
          hasExplicitScript = true;
          i++;
          continue;
        }
        if (tok.startsWith('--expression=') || tok.startsWith('--file=')) {
          hasExplicitScript = true;
          continue;
        }
        if (tok === '-l' || tok === '--line-length') {
          i++;
          continue;
        }
        if (!tok.startsWith('--') && tok.includes('i')) {
          inPlace = true;
        }
        continue;
      }
      positional.push(tok);
    }
    if (inPlace) {
      const fileArgs = hasExplicitScript ? positional : positional.slice(1);
      for (const f of fileArgs) {
        if (isDenyPolicyFile(f, { cwd: activeCwd })) {
          return buildAntiTamperReason(f, activeCwd);
        }
      }
    }
    return null;
  }

  if (bin === 'perl' || bin === 'ruby') {
    let inPlace = false;
    const positional = [];
    let afterDoubleDash = false;
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (!afterDoubleDash && tok === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && tok.startsWith('-') && tok !== '-') {
        if (tok === '-e' || tok === '-E' || tok === '-I' || tok === '-M' || tok === '-m') {
          i++;
          continue;
        }
        if (!tok.startsWith('--') && tok.includes('i')) {
          inPlace = true;
        }
        continue;
      }
      positional.push(tok);
    }
    if (inPlace) {
      for (const f of positional) {
        if (isDenyPolicyFile(f, { cwd: activeCwd })) {
          return buildAntiTamperReason(f, activeCwd);
        }
      }
    }
    return null;
  }

  if (bin === 'awk' || bin === 'gawk' || bin === 'mawk') {
    let inPlace = false;
    let hasScriptFile = false;
    const positional = [];
    let afterDoubleDash = false;
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (!afterDoubleDash && tok === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && tok.startsWith('-') && tok !== '-') {
        if ((tok === '-i' || tok === '--include') && i + 1 < rest.length) {
          if (rest[i + 1] === 'inplace') inPlace = true;
          i++;
          continue;
        }
        if (tok === '-iinplace' || tok === '--include=inplace') {
          inPlace = true;
          continue;
        }
        if (tok === '-f' || tok === '--file') {
          hasScriptFile = true;
          i++;
          continue;
        }
        if (tok === '-F' || tok === '-v' || tok === '-W') {
          i++;
          continue;
        }
        continue;
      }
      positional.push(tok);
    }
    if (inPlace) {
      const fileArgs = hasScriptFile ? positional : positional.slice(1);
      for (const f of fileArgs) {
        if (isDenyPolicyFile(f, { cwd: activeCwd })) {
          return buildAntiTamperReason(f, activeCwd);
        }
      }
    }
    return null;
  }

  if (bin === 'git') {
    const pos = extractPositionalArgs(rest, new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']));
    const sub = pos[0];
    if (sub === 'rm' || sub === 'mv' || sub === 'checkout' || sub === 'restore' || sub === 'clean') {
      for (const a of pos.slice(1)) {
        if (isDenyPolicyFile(a, { cwd: activeCwd })) {
          return buildAntiTamperReason(a, activeCwd);
        }
      }
    }
    return null;
  }

  return null;
}

function parseGrepArgs(rest) {
  let hasQuiet = false;
  let hasVerboseOverride = false;
  let hasExplicitPattern = false;
  const files = [];
  let afterDoubleDash = false;

  const VALUE_FLAGS = new Set([
    '-e',
    '--regexp',
    '-f',
    '--file',
    '-m',
    '--max-count',
    '-A',
    '--after-context',
    '-B',
    '--before-context',
    '-C',
    '--context',
    '-g',
    '--glob',
    '--iglob',
    '-t',
    '--type',
    '-T',
    '--type-not',
    '--include',
    '--exclude',
    '--exclude-dir',
    '--color',
    '--colour',
    '--label',
    '--threads',
    '-j',
    '-d',
    '--directories',
    '-D',
    '--devices',
    '--binary-files',
    '-M',
    '--max-columns',
  ]);
  const EMIT_CONTENT_FLAGS = new Set([
    '--passthru',
    '--json',
    '--vimgrep',
    '--heading',
    '-A',
    '--after-context',
    '-B',
    '--before-context',
    '-C',
    '--context',
    '-o',
    '--only-matching',
  ]);

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!afterDoubleDash && tok === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && tok.startsWith('-') && tok !== '-') {
      if (tok === '-e' || tok === '--regexp' || tok === '-f' || tok === '--file') {
        hasExplicitPattern = true;
        if (tok === '-f' || tok === '--file') {
          if (i + 1 < rest.length) files.push(rest[++i]);
        } else {
          i++;
        }
        continue;
      }
      if (tok.startsWith('--regexp=') || tok.startsWith('--file=')) {
        hasExplicitPattern = true;
        if (tok.startsWith('--file=')) files.push(tok.slice('--file='.length));
        continue;
      }
      if (tok === '-q' || tok === '--quiet' || tok === '--silent') {
        hasQuiet = true;
        continue;
      }
      if (
        EMIT_CONTENT_FLAGS.has(tok) ||
        tok.startsWith('--after-context=') ||
        tok.startsWith('--before-context=') ||
        tok.startsWith('--context=')
      ) {
        hasVerboseOverride = true;
      }
      if (tok.startsWith('--')) {
        if (VALUE_FLAGS.has(tok) && !tok.includes('=')) i++;
        continue;
      }
      if (tok.includes('q')) hasQuiet = true;
      if (tok.includes('o') || tok.includes('A') || tok.includes('B') || tok.includes('C')) {
        hasVerboseOverride = true;
      }
      if (tok.includes('e') || tok.includes('f')) {
        hasExplicitPattern = true;
        if ((tok.endsWith('e') || tok.endsWith('f')) && i + 1 < rest.length) {
          if (tok.endsWith('f')) files.push(rest[i + 1]);
          i++;
        }
        continue;
      }
      if (VALUE_FLAGS.has(tok) && i + 1 < rest.length) {
        i++;
      }
      continue;
    }
    files.push(tok);
  }

  const targetFiles = hasExplicitPattern ? files : files.slice(1);
  return { isZeroStdout: hasQuiet && !hasVerboseOverride, targetFiles };
}

function extractReaderFiles(bin, rest) {
  if (bin === 'sed') {
    let inPlace = false;
    let hasExplicitScript = false;
    const positional = [];
    let afterDoubleDash = false;
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (!afterDoubleDash && tok === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && tok.startsWith('-') && tok !== '-') {
        if (tok === '--in-place' || tok.startsWith('--in-place=')) {
          inPlace = true;
          continue;
        }
        if (tok === '-e' || tok === '--expression' || tok === '-f' || tok === '--file') {
          hasExplicitScript = true;
          if (tok === '-f' || tok === '--file') {
            if (i + 1 < rest.length) positional.push(rest[++i]);
          } else {
            i++;
          }
          continue;
        }
        if (tok.startsWith('--expression=') || tok.startsWith('--file=')) {
          hasExplicitScript = true;
          continue;
        }
        if (tok === '-l' || tok === '--line-length') {
          i++;
          continue;
        }
        if (!tok.startsWith('--') && tok.includes('i')) {
          inPlace = true;
        }
        continue;
      }
      positional.push(tok);
    }
    if (inPlace) return [];
    return hasExplicitScript ? positional : positional.slice(1);
  }

  if (bin === 'awk' || bin === 'gawk' || bin === 'mawk') {
    let hasScriptFile = false;
    const positional = [];
    let afterDoubleDash = false;
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (!afterDoubleDash && tok === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && tok.startsWith('-') && tok !== '-') {
        if (tok === '-f' || tok === '--file') {
          hasScriptFile = true;
          i++;
          continue;
        }
        if (tok === '-F' || tok === '-v' || tok === '-W' || tok === '-i' || tok === '--include') {
          i++;
          continue;
        }
        continue;
      }
      positional.push(tok);
    }
    return hasScriptFile ? positional : positional.slice(1);
  }

  if (bin === 'jq' || bin === 'yq') {
    let hasFilterFile = false;
    let nullInput = false;
    const positional = [];
    let afterDoubleDash = false;
    const oneArgFlags = new Set([
      '-f',
      '--from-file',
      '-L',
      '--indent',
      '-o',
      '-p',
      '--output-format',
      '--input-format',
    ]);
    const twoArgFlags = new Set(['--arg', '--argjson', '--slurpfile', '--rawfile']);
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (!afterDoubleDash && tok === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && tok.startsWith('-') && tok !== '-') {
        if (tok === '-n' || tok === '--null-input') {
          nullInput = true;
          continue;
        }
        if (tok === '-f' || tok === '--from-file') {
          hasFilterFile = true;
          i++;
          continue;
        }
        if (twoArgFlags.has(tok)) {
          i += 2;
          continue;
        }
        if (!tok.includes('=') && oneArgFlags.has(tok)) {
          i++;
          continue;
        }
        continue;
      }
      positional.push(tok);
    }
    if (nullInput) return [];
    return hasFilterFile ? positional : positional.slice(1);
  }

  const valueFlags = new Set([
    '-n',
    '-c',
    '--lines',
    '--bytes',
    '-d',
    '-f',
    '-b',
    '--delimiter',
    '--fields',
    '--bytes',
    '--characters',
    '--output-delimiter',
    '-w',
    '--wrap',
    '-l',
    '-s',
    '-N',
    '-j',
    '-t',
    '-e',
    '--language',
    '--theme',
    '--style',
    '--line-range',
  ]);
  return extractPositionalArgs(rest, valueFlags);
}

function checkShellFileRead(stage, bin, rest, policy, { cwd, homeDir }) {
  if (!bin || !STDOUT_FILE_READERS.has(bin)) return null;

  let fileArgs = [];
  if (bin === 'grep' || bin === 'egrep' || bin === 'fgrep' || bin === 'rg') {
    const parsed = parseGrepArgs(rest);
    if (parsed.isZeroStdout) return null;
    fileArgs = parsed.targetFiles;
  } else {
    fileArgs = extractReaderFiles(bin, rest);
  }

  const candidates = [...fileArgs, ...(stage.inputFiles || [])].filter((f) => f && f !== '-');
  for (const target of candidates) {
    const hit = checkPathReadTarget(policy, target, { cwd, homeDir });
    if (hit) return hit;
  }
  return null;
}

function hasTextPrinterDownstream(list, stageIndex) {
  const downstream = list.stages.slice(stageIndex + 1);
  return downstream.some((st) => st.bin && TEXT_PRINTER_SINKS.has(st.bin));
}

function evaluateDecryptDestination(stage, list, toolName, outputFlagTarget) {
  if (outputFlagTarget !== null) {
    if (outputFlagTarget === '/dev/null') {
      return { decision: 'allow', reason: null };
    }
    if (outputFlagTarget !== '-') {
      return {
        decision: 'ask',
        reason:
          `Decryption via \`${toolName}\` writes plaintext to file \`${outputFlagTarget}\` (\`@shell:sops-decrypt\`). ` +
          'Confirm with the user before running, or prefer `sops exec-env` / `sops exec-file` (see `skills/secure-credential-handoff/SKILL.md`).',
      };
    }
  }

  if (stage.stdoutDestination === 'devnull') {
    return { decision: 'allow', reason: null };
  }

  if (stage.stdoutDestination === 'file') {
    return {
      decision: 'ask',
      reason:
        `Decryption via \`${toolName}\` redirects plaintext to a file (\`@shell:sops-decrypt\`). ` +
        'Confirm with the user before running, or prefer `sops exec-env` / `sops exec-file` (see `skills/secure-credential-handoff/SKILL.md`).',
    };
  }

  if (stage.stdoutDestination === 'pipe') {
    if (hasTextPrinterDownstream(list, stage.stageIndex)) {
      return {
        decision: 'deny',
        reason:
          `Refusing \`${toolName}\` decryption piped into a text/JSON printer (\`@shell:sops-decrypt\`). ` +
          'Use `sops exec-env` or `sops exec-file` (see `skills/secure-credential-handoff/SKILL.md`), or redirect to `/dev/null` if only validating decryption.',
      };
    }
    return {
      decision: 'ask',
      reason:
        `Decryption via \`${toolName}\` pipes plaintext to a downstream consumer (\`@shell:sops-decrypt\`). ` +
        'Confirm with the user before running, or prefer `sops exec-env` / `sops exec-file` (see `skills/secure-credential-handoff/SKILL.md`).',
    };
  }

  return {
    decision: 'deny',
    reason:
      `Refusing \`${toolName}\` decryption to terminal stdout (\`@shell:sops-decrypt\`). ` +
      'Use `sops exec-env` or `sops exec-file` (see `skills/secure-credential-handoff/SKILL.md`), or redirect to `/dev/null` if only validating decryption.',
  };
}

function checkSopsDecrypt(stage, list, bin, rest, activeCwd, evaluateCmdFn) {
  if (bin === 'sops') {
    const pos = extractPositionalArgs(
      rest,
      new Set(['--output', '--output-type', '--input-type', '--config', '--kms', '--pgp', '--age', '--gcp-kms', '--azure-kv', '--hc-vault-transit', '--user', '--filename']),
    );
    const sub = pos[0];

    if (sub === 'exec-env' || sub === 'exec-file') {
      // Child command string follows the sops file argument
      const childCmdParts = pos.slice(2);
      if (childCmdParts.length > 0) {
        const childCmd = childCmdParts.join(' ');
        if (sub === 'exec-file') {
          const childLists = parseCommandLists(stripHeredocs(childCmd));
          for (const cl of childLists) {
            for (const cs of cl.stages) {
              if (cs.bin && STDOUT_FILE_READERS.has(cs.bin) && cs.tokens.includes('{}')) {
                return {
                  decision: 'deny',
                  reason:
                    'Refusing `sops exec-file` child command reading decrypted `{}` to stdout (`@shell:sops-decrypt`). ' +
                    'Pass the file path to a program that consumes it without printing secret contents.',
                };
              }
            }
          }
        }
        const innerRes = evaluateCmdFn(childCmd, activeCwd);
        if (innerRes.decision !== 'allow') return innerRes;
      }
      return { decision: 'allow', reason: null };
    }

    let isDecrypt = sub === 'decrypt';
    let inPlace = false;
    let outputTarget = null;
    let afterDoubleDash = false;
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (!afterDoubleDash && tok === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (afterDoubleDash) continue;
      if (tok === '--decrypt' || tok === '-d') {
        isDecrypt = true;
        continue;
      }
      if (!tok.startsWith('--') && tok.startsWith('-') && tok !== '-' && tok.includes('d')) {
        isDecrypt = true;
      }
      if (tok === '-i' || tok === '--in-place' || (!tok.startsWith('--') && tok.startsWith('-') && tok.includes('i'))) {
        inPlace = true;
      }
      if (tok === '--output' && i + 1 < rest.length) {
        outputTarget = rest[++i];
      } else if (tok.startsWith('--output=')) {
        outputTarget = tok.slice('--output='.length);
      }
    }

    if (!isDecrypt) return null;
    if (inPlace && outputTarget === null) {
      return {
        decision: 'ask',
        reason:
          'Decryption via `sops -d -i` writes plaintext in-place on disk (`@shell:sops-decrypt`). ' +
          'Confirm with the user before running, or prefer `sops exec-env` / `sops exec-file` (see `skills/secure-credential-handoff/SKILL.md`).',
      };
    }
    return evaluateDecryptDestination(stage, list, 'sops', outputTarget);
  }

  if (bin === 'ansible-vault') {
    const pos = extractPositionalArgs(rest, new Set(['--output', '--vault-id', '--vault-password-file', '--new-vault-id', '--new-vault-password-file']));
    const sub = pos[0];
    if (sub !== 'view' && sub !== 'decrypt') return null;

    let outputTarget = null;
    let afterDoubleDash = false;
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (!afterDoubleDash && tok === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (afterDoubleDash) continue;
      if (tok === '--output' && i + 1 < rest.length) {
        outputTarget = rest[++i];
      } else if (tok.startsWith('--output=')) {
        outputTarget = tok.slice('--output='.length);
      }
    }

    return evaluateDecryptDestination(stage, list, 'ansible-vault', outputTarget);
  }

  return null;
}

function checkEnvDump(bin, rest, isBareEnvDump, { xtraceActive, policy, cwd, homeDir }) {
  if (isBareEnvDump) {
    return {
      decision: 'deny',
      reason:
        'Refusing unfiltered `env` command (`@shell:env-dump`): printing environment variables exposes credentials in transcripts. ' +
        'See `skills/secure-credential-handoff/SKILL.md`.',
    };
  }

  if (!bin) return null;

  if (bin === 'printenv') {
    let sawHelpOrVersion = false;
    const vars = [];
    for (const tok of rest) {
      if (tok === '--help' || tok === '--version') {
        sawHelpOrVersion = true;
        continue;
      }
      if (tok.startsWith('-')) continue;
      vars.push(tok);
    }
    if (sawHelpOrVersion && vars.length === 0) return null;
    if (vars.length === 0 || vars.some((v) => SECRET_VAR_NAME_RE.test(v))) {
      return {
        decision: 'deny',
        reason:
          'Refusing `printenv` (`@shell:env-dump`): printing environment variables or secret-named variables exposes credentials in transcripts. ' +
          'See `skills/secure-credential-handoff/SKILL.md`.',
      };
    }
    return null;
  }

  if (bin === 'export') {
    const hasPrintFlag = rest.some((t) => !t.startsWith('--') && t.startsWith('-') && t.includes('p'));
    if (rest.length === 0 || hasPrintFlag) {
      return {
        decision: 'deny',
        reason:
          'Refusing `export -p` (`@shell:env-dump`): printing exported variables exposes credentials in transcripts. ' +
          'See `skills/secure-credential-handoff/SKILL.md`.',
      };
    }
    return null;
  }

  if (bin === 'declare' || bin === 'typeset') {
    if (rest.length === 0) {
      return {
        decision: 'deny',
        reason:
          `Refusing bare \`${bin}\` (\`@shell:env-dump\`): printing shell variables exposes credentials in transcripts. ` +
          'See `skills/secure-credential-handoff/SKILL.md`.',
      };
    }
    let hasPrintFlag = false;
    const varArgs = [];
    for (const tok of rest) {
      if (tok === '--') continue;
      if (tok.startsWith('-') && !tok.startsWith('--')) {
        if (tok.includes('p')) hasPrintFlag = true;
        continue;
      }
      if (!tok.includes('=')) {
        varArgs.push(tok);
      }
    }
    if (hasPrintFlag && (varArgs.length === 0 || varArgs.some((v) => SECRET_VAR_NAME_RE.test(v)))) {
      return {
        decision: 'deny',
        reason:
          `Refusing \`${bin} -p\` (\`@shell:env-dump\`): printing shell variables exposes credentials in transcripts. ` +
          'See `skills/secure-credential-handoff/SKILL.md`.',
      };
    }
    return null;
  }

  if (bin === 'set') {
    if (rest.length === 0) {
      return {
        decision: 'deny',
        reason:
          'Refusing bare `set` (`@shell:env-dump`): printing all shell variables exposes credentials in transcripts. ' +
          'See `skills/secure-credential-handoff/SKILL.md`.',
      };
    }
    return null;
  }

  if ((bin === 'source' || bin === '.') && xtraceActive) {
    const target = rest.find((t) => t && !t.startsWith('-'));
    if (target && checkPathReadTarget(policy, target, { cwd, homeDir })) {
      return {
        decision: 'deny',
        reason:
          `Refusing \`${bin} ${target}\` with \`xtrace\` (\`-x\`) enabled (\`@shell:env-dump\`): ` +
          'xtrace echoes sourced secret values into transcripts. Remove `-x` / `set -x` when sourcing credential files.',
      };
    }
  }

  if ((bin === 'bash' || bin === 'sh' || bin === 'zsh' || bin === 'dash') && !parseNestedCommand([bin, ...rest])) {
    let hasX = false;
    let scriptTarget = null;
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok === '-o' && rest[i + 1] === 'xtrace') {
        hasX = true;
        i++;
        continue;
      }
      if (tok.startsWith('-') && !tok.startsWith('--')) {
        if (tok.includes('x')) hasX = true;
        continue;
      }
      if (!tok.startsWith('-')) {
        scriptTarget = tok;
        break;
      }
    }
    if (hasX && scriptTarget && checkPathReadTarget(policy, scriptTarget, { cwd, homeDir })) {
      return {
        decision: 'deny',
        reason:
          `Refusing \`${bin} -x ${scriptTarget}\` (\`@shell:env-dump\`): ` +
          'xtrace echoes secret file contents into transcripts.',
      };
    }
  }

  return null;
}

function hasShellXtraceFlag(bin, rest) {
  if (bin !== 'bash' && bin !== 'sh' && bin !== 'zsh' && bin !== 'dash') return false;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--' || tok === '-c') break;
    if (tok === '-o' && rest[i + 1] === 'xtrace') return true;
    if (tok.startsWith('-') && !tok.startsWith('--') && tok.includes('x')) return true;
  }
  return false;
}

function updateXtraceState(bin, rest, currentXtrace) {
  if (bin !== 'set') return currentXtrace;
  let next = currentXtrace;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') break;
    if (tok === '-o' && rest[i + 1] === 'xtrace') {
      next = true;
      i++;
      continue;
    }
    if (tok === '+o' && rest[i + 1] === 'xtrace') {
      next = false;
      i++;
      continue;
    }
    if (tok.startsWith('-') && !tok.startsWith('--') && tok.includes('x')) {
      next = true;
    } else if (tok.startsWith('+') && tok.includes('x')) {
      next = false;
    }
  }
  return next;
}

function checkCliSecretDump(bin, rest) {
  if (!bin) return null;

  if (bin === 'rclone') {
    const pos = extractPositionalArgs(
      rest,
      new Set(['--config', '--password-command', '--log-file', '--cache-dir', '--temp-dir', '--transfers', '--checkers']),
    );
    if (pos[0] === 'config' && (pos[1] === 'show' || pos[1] === 'dump')) {
      return {
        decision: 'deny',
        reason:
          `Refusing \`rclone config ${pos[1]}\` (\`@shell:cli-secret-dump\`): dumps plaintext remote credentials to stdout. ` +
          'Use `rclone listremotes` or inspect config structure without credentials.',
      };
    }
    return null;
  }

  if (bin === 'kubectl') {
    const valueFlags = new Set([
      '-n',
      '--namespace',
      '--context',
      '--kubeconfig',
      '--cluster',
      '--user',
      '-s',
      '--server',
      '--token',
      '--as',
      '--as-group',
      '--cache-dir',
      '--certificate-authority',
      '--client-certificate',
      '--client-key',
      '-o',
      '--output',
      '-l',
      '--selector',
      '--field-selector',
      '--sort-by',
      '-v',
      '--v',
    ]);

    let outputFormat = null;
    let hasRaw = false;
    const positional = [];
    let afterDoubleDash = false;

    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (!afterDoubleDash && tok === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && tok.startsWith('-') && tok !== '-') {
        if (tok === '--raw' || tok === '--raw=true') {
          hasRaw = true;
          continue;
        }
        if ((tok === '-o' || tok === '--output') && i + 1 < rest.length) {
          outputFormat = rest[++i];
          continue;
        }
        if (tok.startsWith('--output=')) {
          outputFormat = tok.slice('--output='.length);
          continue;
        }
        if (tok.startsWith('-o=')) {
          outputFormat = tok.slice(3);
          continue;
        }
        if (tok.startsWith('-o') && tok.length > 2) {
          outputFormat = tok.slice(2);
          continue;
        }
        if (!tok.includes('=') && valueFlags.has(tok) && i + 1 < rest.length) {
          i++;
        }
        continue;
      }
      positional.push(tok);
    }

    if (positional[0] === 'config' && positional[1] === 'view' && hasRaw) {
      return {
        decision: 'deny',
        reason:
          'Refusing `kubectl config view --raw` (`@shell:cli-secret-dump`): outputs raw kubeconfig certificates and tokens to stdout.',
      };
    }

    if (positional[0] === 'get' && positional[1]) {
      const resourceSpec = positional[1];
      const targetsSecret = resourceSpec
        .split(',')
        .some((seg) => /^secrets?(?:\/|\.|$)/i.test(seg.trim()));

      if (targetsSecret && outputFormat) {
        const fmt = outputFormat.split('=')[0].trim().toLowerCase();
        if (
          fmt === 'yaml' ||
          fmt === 'json' ||
          fmt.startsWith('jsonpath') ||
          fmt.startsWith('go-template') ||
          fmt.startsWith('custom-columns') ||
          fmt.startsWith('template')
        ) {
          return {
            decision: 'deny',
            reason:
              `Refusing \`kubectl get ${resourceSpec} -o ${outputFormat}\` (\`@shell:cli-secret-dump\`): ` +
              'outputs base64/plaintext Secret values to stdout. Use plain `kubectl get secrets` for metadata only.',
          };
        }
      }
    }
    return null;
  }

  if (bin === 'terraform' || bin === 'tofu' || bin === 'terragrunt') {
    let hasJsonOrRaw = false;
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok === '-chdir' && i + 1 < rest.length) {
        i++;
        continue;
      }
      if (tok.startsWith('-chdir=')) continue;
      if (tok === '-json' || tok === '--json' || tok === '-json=true' || tok === '-raw' || tok === '--raw' || tok === '-raw=true') {
        hasJsonOrRaw = true;
        continue;
      }
      if (tok.startsWith('-')) continue;
      positional.push(tok);
    }

    if (positional[0] === 'state' && positional[1] === 'pull') {
      return {
        decision: 'deny',
        reason:
          `Refusing \`${bin} state pull\` (\`@shell:cli-secret-dump\`): dumps full remote state (including secrets) to stdout.`,
      };
    }
    if (positional[0] === 'output' && hasJsonOrRaw) {
      return {
        decision: 'deny',
        reason:
          `Refusing \`${bin} output\` with \`-json\`/\`-raw\` (\`@shell:cli-secret-dump\`): exposes sensitive output values in stdout.`,
      };
    }
  }

  return null;
}

function collectStagePathCandidates(stage, bin, rest) {
  const paths = [...(stage.inputFiles || [])];
  for (const r of stage.redirections) {
    if (r.isOutput && r.target && !r.isDevNull) paths.push(r.target);
  }
  for (const tok of rest) {
    if (tok && !tok.startsWith('-')) paths.push(tok);
  }
  if (bin && !bin.startsWith('-')) paths.push(bin);
  return paths;
}

function resolveStagePolicy(activeCwd, initialCwd, stage, bin, rest, { homeDir, rigRoot, policyCache }) {
  const getPolicy = (dir) => {
    const key = path.resolve(dir);
    if (!policyCache.has(key)) {
      policyCache.set(key, loadDenyPolicy({ cwd: key, homeDir, rigRoot }));
    }
    return policyCache.get(key);
  };

  if (isDirectoryInRiggedRepo(activeCwd)) {
    return { activeInRigged: true, policy: getPolicy(activeCwd) };
  }
  if (isDirectoryInRiggedRepo(initialCwd)) {
    return { activeInRigged: true, policy: getPolicy(initialCwd) };
  }
  for (const candidate of collectStagePathCandidates(stage, bin, rest)) {
    if (isTargetInRiggedRepo(candidate, activeCwd, homeDir)) {
      const anc = existingAncestor(resolvePathInput(candidate, activeCwd, homeDir), activeCwd);
      if (anc) {
        return { activeInRigged: true, policy: getPolicy(anc) };
      }
    }
  }
  return { activeInRigged: false, policy: null };
}

export function evaluateCommand(command, cwd = process.cwd(), options = {}, _depth = 0, _state = null) {
  if (typeof command !== 'string' || !command.trim() || _depth > 10) {
    return { decision: 'allow', reason: null };
  }

  const homeDir = options.homeDir ?? homedir();
  const rigRoot = options.rigRoot;
  const initialCwd = _state?.initialCwd ?? cwd;
  const policyCache = _state?.policyCache ?? new Map();
  let xtraceActive = _state?.xtraceActive ?? false;
  let activeCwd = cwd;
  let pendingAsk = null;

  const mergeResult = (res) => {
    if (!res || res.decision === 'allow') return null;
    if (res.decision === 'deny') return res;
    if (res.decision === 'ask' && !pendingAsk) {
      pendingAsk = res;
    }
    return null;
  };

  const stripped = stripHeredocs(command);
  const lists = parseCommandLists(stripped);

  for (const list of lists) {
    if (list.stages.length === 1) {
      const cdTarget = parseCdSegment(list.stages[0].tokens);
      if (cdTarget) {
        activeCwd = resolvePathInput(cdTarget, activeCwd, homeDir) || activeCwd;
        continue;
      }
    }

    for (const stage of list.stages) {
      // 1. Subshells ($( ... ) and `...`)
      for (const sub of extractSubshells(stage.raw)) {
        const subRes = evaluateCommand(sub, activeCwd, options, _depth + 1, {
          initialCwd,
          policyCache,
          xtraceActive,
        });
        const halt = mergeResult(subRes);
        if (halt) return halt;
      }

      const strippedTokens = stripWrappers(stage.tokens);
      const unwrapped = unwrapEnvCommand(stage.tokens, strippedTokens);
      const bin = unwrapped.bin;
      const rest = unwrapped.rest;

      const { activeInRigged, policy } = resolveStagePolicy(activeCwd, initialCwd, stage, bin, rest, {
        homeDir,
        rigRoot,
        policyCache,
      });

      if (activeInRigged && policy) {
        // 2. Hardcoded anti-tamper self-protection of .rig/deny and .rig/deny.local
        const tamperReason = checkStageAntiTamper(stage, bin, rest, activeCwd);
        if (tamperReason) {
          return { decision: 'deny', reason: tamperReason };
        }
      }

      // 3. Nested shells (bash/sh/zsh/dash -c, eval)
      const nestedTokens = bin ? [bin, ...rest] : stage.tokens;
      const nested = parseNestedCommand(nestedTokens);
      if (nested) {
        const nestedXtrace = xtraceActive || (bin ? hasShellXtraceFlag(bin, rest) : false);
        const nestedRes = evaluateCommand(nested, activeCwd, options, _depth + 1, {
          initialCwd,
          policyCache,
          xtraceActive: nestedXtrace,
        });
        const halt = mergeResult(nestedRes);
        if (halt) return halt;
        continue;
      }

      if (!activeInRigged || !policy) {
        continue;
      }

      // 4. @shell:file-read
      if (isRuleEnabled(policy, 'shell:file-read')) {
        const readRes = checkShellFileRead(stage, bin, rest, policy, { cwd: activeCwd, homeDir });
        const halt = mergeResult(readRes);
        if (halt) return halt;
      }

      // 5. @shell:sops-decrypt
      if (isRuleEnabled(policy, 'shell:sops-decrypt')) {
        const sopsRes = checkSopsDecrypt(stage, list, bin, rest, activeCwd, (childCmd, childCwd) =>
          evaluateCommand(childCmd, childCwd, options, _depth + 1, {
            initialCwd,
            policyCache,
            xtraceActive,
          }),
        );
        const halt = mergeResult(sopsRes);
        if (halt) return halt;
      }

      // 6. @shell:env-dump
      if (isRuleEnabled(policy, 'shell:env-dump')) {
        const envRes = checkEnvDump(bin, rest, unwrapped.isBareEnvDump, {
          xtraceActive,
          policy,
          cwd: activeCwd,
          homeDir,
        });
        const halt = mergeResult(envRes);
        if (halt) return halt;
      }

      if (bin) {
        xtraceActive = updateXtraceState(bin, rest, xtraceActive);
      }

      // 7. @shell:cli-secret-dump
      if (isRuleEnabled(policy, 'shell:cli-secret-dump')) {
        const cliRes = checkCliSecretDump(bin, rest);
        const halt = mergeResult(cliRes);
        if (halt) return halt;
      }
    }
  }

  return pendingAsk ?? { decision: 'allow', reason: null };
}

export function evaluateToolCall(parsed, options = {}) {
  if (!parsed || typeof parsed !== 'object') {
    return { decision: 'allow', reason: null };
  }

  const cwd = (typeof parsed.cwd === 'string' && parsed.cwd.trim()) ? parsed.cwd : process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const rigRoot = options.rigRoot;
  const toolName = parsed.toolName || '';
  const command = parsed.command || '';

  if (command && command.trim()) {
    return evaluateCommand(command, cwd, { homeDir, rigRoot });
  }

  const isSearch = SEARCH_TOOLS.has(toolName) || (!parsed.filePath && (Boolean(parsed.searchPath) || (parsed.searchGlobs?.length ?? 0) > 0));
  const targetPath = isSearch ? (parsed.searchPath || parsed.filePath) : (parsed.filePath || parsed.searchPath);

  const cwdRigged = isDirectoryInRiggedRepo(cwd);
  const targetRigged = targetPath ? isTargetInRiggedRepo(targetPath, cwd, homeDir) : false;

  // Enforce strict unrigged repository isolation (ADR 0004 & ADR 0006 Decision 4).
  if (!cwdRigged && !targetRigged) {
    return { decision: 'allow', reason: null };
  }

  if (EDIT_TOOLS.has(toolName)) {
    if (targetPath && isDenyPolicyFile(resolvePathInput(targetPath, cwd, homeDir) || targetPath, { cwd })) {
      return { decision: 'deny', reason: buildAntiTamperReason(targetPath, cwd) };
    }
    return { decision: 'allow', reason: null };
  }

  const policyCwd = cwdRigged ? cwd : (existingAncestor(resolvePathInput(targetPath, cwd, homeDir), cwd) || cwd);
  const policy = loadDenyPolicy({ cwd: policyCwd, homeDir, rigRoot });

  if (isSearch) {
    return evaluateSearchTool(policy, targetPath, parsed.searchGlobs, { cwd, homeDir });
  }

  if (targetPath) {
    const readHit = checkPathReadTarget(policy, targetPath, { cwd, homeDir });
    if (readHit) return readHit;
  }

  return { decision: 'allow', reason: null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let parsed;
  try {
    parsed = readHookInput();
  } catch {
    process.exit(0);
  }
  try {
    const res = evaluateToolCall(parsed);
    emitDecision(parsed.schema, res.decision, res.reason);
  } catch {
    emitDecision(parsed.schema, 'allow');
  }
}
