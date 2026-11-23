#!/usr/bin/env node
// PreToolUse shell guard (`run_command` in Antigravity, `Bash` in Claude Code):
// prompts the user before any command that reaches or mutates state outside the
// working tree — a remote host, a shared repository, or the host's scheduled
// tasks. Local commands run unprompted, and explicitly allowlisted remote hosts
// (`rig allow remote <host>` or `# agent-rig: allow` in `~/.ssh/config`) are
// auto-allowed for SSH-family and remote Docker commands.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHookInput, emitDecision, isDirectoryInRiggedRepo } from './lib/hook-io.mjs';
import { getAllowedHosts, normalizeHost } from './lib/remote-allowlist.mjs';

function stripHeredocs(cmd) {
  const lines = cmd.split('\n');
  const out = [];
  let endToken = null;
  for (const line of lines) {
    if (endToken !== null) {
      if (line.trim() === endToken) endToken = null;
      continue;
    }
    const m = line.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/);
    if (m) endToken = m[1] ?? m[2] ?? m[3];
    out.push(line);
  }
  return out.join('\n');
}

function maskQuotes(s) {
  return s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""');
}

function tokenize(seg) {
  const tokens = [];
  const re = /'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec']);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function stripWrappers(tokens) {
  let i = 0;
  const envAssignments = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (ASSIGN_RE.test(t)) {
      envAssignments.push(t);
      i++;
      continue;
    }
    if (WRAPPERS.has(t)) {
      i++;
      continue;
    }
    break;
  }
  return {
    bin: tokens[i] ? path.basename(tokens[i]) : null,
    rest: tokens.slice(i + 1),
    envAssignments,
  };
}

function parseCdSegment(seg) {
  const { bin, rest } = stripWrappers(tokenize(seg));
  if (bin !== 'cd') return null;
  for (const tok of rest) {
    if (tok.startsWith('-')) continue;
    return tok;
  }
  return null;
}

function parseNestedCommand(seg) {
  const { bin, rest } = stripWrappers(tokenize(seg));
  if (!bin) return null;
  if (bin === 'bash' || bin === 'sh' || bin === 'zsh' || bin === 'dash') {
    for (let j = 0; j < rest.length - 1; j++) {
      if (rest[j] === '-c') return rest[j + 1];
    }
    return null;
  }
  if (bin === 'eval' && rest.length > 0) {
    return rest.join(' ');
  }
  return null;
}

function splitSegments(cmd) {
  const masked = cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (m) => ' '.repeat(m.length));
  const cuts = [0];
  const sepRe = /[;&|\n]+/g;
  let m;
  while ((m = sepRe.exec(masked)) !== null) {
    cuts.push(m.index, m.index + m[0].length);
  }
  cuts.push(cmd.length);
  const segs = [];
  for (let i = 0; i < cuts.length; i += 2) {
    const s = cmd.slice(cuts[i], cuts[i + 1]).trim();
    if (s) segs.push(s);
  }
  return segs;
}

function extractSubshells(str) {
  const subshells = [];
  let i = 0;
  let inDoubleQuote = false;

  while (i < str.length) {
    const ch = str[i];

    if (!inDoubleQuote && ch === "'") {
      i++;
      while (i < str.length && str[i] !== "'") {
        i++;
      }
      if (i < str.length) i++;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = !inDoubleQuote;
      i++;
      continue;
    }

    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (ch === '$' && str[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      const start = j;
      let innerInDoubleQuote = false;

      while (j < str.length && depth > 0) {
        const c = str[j];

        if (!innerInDoubleQuote && c === "'") {
          j++;
          while (j < str.length && str[j] !== "'") j++;
          if (j < str.length) j++;
          continue;
        }

        if (c === '"') {
          innerInDoubleQuote = !innerInDoubleQuote;
          j++;
          continue;
        }

        if (c === '\\') {
          j += 2;
          continue;
        }

        if (c === '(') {
          depth++;
        } else if (c === ')') {
          depth--;
          if (depth === 0) {
            break;
          }
        }
        j++;
      }

      subshells.push(str.slice(start, j));
      i = j + 1;
      continue;
    }

    if (ch === '`') {
      let j = i + 1;
      const start = j;
      while (j < str.length) {
        if (str[j] === '\\') {
          j += 2;
          continue;
        }
        if (str[j] === '`') {
          break;
        }
        j++;
      }
      subshells.push(str.slice(start, j));
      i = j + 1;
      continue;
    }

    i++;
  }

  return subshells;
}

function getCurrentBranch(cwd) {
  try {
    const res = spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status === 0 && typeof res.stdout === 'string') {
      return res.stdout.trim();
    }
  } catch {
    // Ignore spawn errors
  }
  return null;
}

const PUSH_FLAGS_WITH_ARG = new Set([
  '--repo',
  '-o',
  '--push-option',
  '--receive-pack',
  '--exec',
]);

function checkGitPush(seg, cwd) {
  const tokens = tokenize(seg);
  const { bin, rest } = stripWrappers(tokens);
  if (bin !== 'git') return null;

  let activeCwd = cwd;
  let pushIdx = -1;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '-C' && i + 1 < rest.length) {
      activeCwd = path.resolve(activeCwd, rest[i + 1]);
      i++;
      continue;
    }
    if (tok.startsWith('-C') && tok.length > 2) {
      activeCwd = path.resolve(activeCwd, tok.slice(2));
      continue;
    }
    if (tok === 'push') {
      pushIdx = i;
      break;
    }
    if (!tok.startsWith('-')) {
      return null;
    }
  }

  if (pushIdx === -1) return null;

  // Enforce remote mutation guards only inside rigged repositories
  // (governed by docs/adr/0004-strict-unrigged-repository-isolation.md).
  if (!isDirectoryInRiggedRepo(activeCwd)) return null;

  const pushArgs = rest.slice(pushIdx + 1);
  let isForce = false;
  let isMainMaster = false;
  const positional = [];

  for (let j = 0; j < pushArgs.length; j++) {
    const arg = pushArgs[j];
    if (arg === '--') {
      positional.push(...pushArgs.slice(j + 1));
      break;
    }
    if (arg.startsWith('-')) {
      if (PUSH_FLAGS_WITH_ARG.has(arg)) {
        j++;
        continue;
      }
      if (
        arg === '--force' ||
        arg === '--force-with-lease' ||
        arg.startsWith('--force-with-lease=') ||
        arg === '--force-if-includes' ||
        arg === '--delete' ||
        arg === '-d' ||
        (!arg.startsWith('--') && arg.includes('f'))
      ) {
        isForce = true;
      }
      continue;
    }
    positional.push(arg);
  }

  for (let k = 0; k < positional.length; k++) {
    const pos = positional[k];
    if (pos.startsWith('+') || pos.startsWith(':')) {
      isForce = true;
    }
    const target = pos.includes(':') ? pos.slice(pos.indexOf(':') + 1) : pos;
    const cleanTarget = target.startsWith('+') ? target.slice(1) : target;
    if (
      cleanTarget === 'main' ||
      cleanTarget === 'master' ||
      cleanTarget.endsWith('/main') ||
      cleanTarget.endsWith('/master')
    ) {
      isMainMaster = true;
    }
  }

  if (isMainMaster) {
    return 'pushes directly to `main` / `master`';
  }
  if (isForce) {
    return 'force-pushes or deletes a remote ref';
  }

  if (positional.length === 0 || (positional.length === 1 && !positional[0].startsWith('+') && !positional[0].includes(':'))) {
    const branch = getCurrentBranch(activeCwd);
    if (branch === 'main' || branch === 'master') {
      return 'pushes directly to `main` / `master`';
    }
  }

  return null;
}

/**
 * Prevents agents from silently mutating the agent-rig remote host allowlist itself.
 * Read-only `--list` / `list` / `--help` invocations pass unprompted.
 */
function checkRigAllowMutation(seg) {
  const { bin, rest } = stripWrappers(tokenize(seg));
  if (!bin) return null;

  let subIdx = -1;
  if (bin === 'rig' || bin === 'rig.mjs') {
    subIdx = 0;
  } else if (bin === 'node' && rest.length >= 2) {
    const scriptName = path.basename(rest[0]);
    if (scriptName === 'rig.mjs' || scriptName === 'rig') {
      subIdx = 1;
    }
  }
  if (subIdx === -1 || rest[subIdx] !== 'allow') return null;

  const allowArgs = rest.slice(subIdx + 1);
  const isReadOnly = allowArgs.some((a) => a === '--list' || a === '-l' || a === 'list' || a === '--help' || a === '-h');
  if (isReadOnly) return null;

  return 'modifies the agent-rig remote host allowlist (`rig allow`)';
}

const SSH_REASON = 'reaches a remote host over SSH (`ssh` / `scp` / `sftp` / `rsync`)';

const SSH_FLAGS_WITH_ARG = new Set(['B', 'b', 'c', 'D', 'E', 'e', 'F', 'I', 'i', 'J', 'L', 'l', 'm', 'O', 'o', 'P', 'p', 'Q', 'R', 'S', 'W', 'w']);
const SCP_FLAGS_WITH_ARG = new Set(['c', 'F', 'i', 'J', 'l', 'o', 'P', 'S']);
const SFTP_FLAGS_WITH_ARG = new Set(['B', 'b', 'c', 'D', 'F', 'i', 'J', 'l', 'o', 'P', 'R', 'S', 's']);
const RSYNC_SHORT_WITH_ARG = new Set(['e', 'f', 'T', 'B', 'M']);
const RSYNC_LONG_WITH_ARG = new Set([
  '--rsh',
  '--rsync-path',
  '--exclude',
  '--exclude-from',
  '--include',
  '--include-from',
  '--files-from',
  '--filter',
  '--compare-dest',
  '--copy-dest',
  '--link-dest',
  '--backup-dir',
  '--suffix',
  '--temp-dir',
  '--partial-dir',
  '--log-file',
  '--log-file-format',
  '--out-format',
  '--bwlimit',
  '--max-size',
  '--min-size',
  '--port',
  '--password-file',
  '--chmod',
  '--chown',
  '--usermap',
  '--groupmap',
  '--iconv',
  '--address',
  '--sockopts',
  '--timeout',
  '--contimeout',
  '--block-size',
  '--modify-window',
  '--info',
  '--debug',
  '--stderr',
  '--stop-after',
  '--stop-at',
  '--remote-option',
]);

function inspectSshOption(optStr, extraHosts) {
  if (typeof optStr !== 'string') return false;
  const trimmed = optStr.trim();
  const m = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed);
  if (!m) return false;
  const key = m[1].toLowerCase();
  const val = m[2].trim();

  if (key === 'proxycommand' || key === 'localcommand') {
    return false;
  }
  if (key === 'proxyjump') {
    if (val.toLowerCase() === 'none') return true;
    const hops = val.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length === 0) return false;
    for (const hop of hops) {
      const h = normalizeHost(hop);
      if (!h) return false;
      extraHosts.push(h);
    }
    return true;
  }
  if (key === 'hostname') {
    const h = normalizeHost(val);
    if (!h) return false;
    extraHosts.push(h);
    return true;
  }
  return true;
}

function parseSshStyleArgs(rest, flagsWithArg) {
  const positional = [];
  const extraHosts = [];
  let unsafeOption = false;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (tok.startsWith('-') && tok.length > 1) {
      let consumedArg = false;
      for (let c = 1; c < tok.length; c++) {
        const ch = tok[c];
        if (!flagsWithArg.has(ch)) continue;
        let argVal;
        if (c + 1 < tok.length) {
          argVal = tok.slice(c + 1);
        } else if (i + 1 < rest.length) {
          argVal = rest[++i];
        } else {
          unsafeOption = true;
          break;
        }
        consumedArg = true;
        if (ch === 'F') {
          // Custom ssh_config file can redirect hostnames or inject ProxyCommand; fail closed
          unsafeOption = true;
        } else if (ch === 'J') {
          const hops = argVal.split(',').map((h) => h.trim()).filter(Boolean);
          if (hops.length === 0) {
            unsafeOption = true;
          } else {
            for (const hop of hops) {
              const h = normalizeHost(hop);
              if (!h) unsafeOption = true;
              else extraHosts.push(h);
            }
          }
        } else if (ch === 'o') {
          if (!inspectSshOption(argVal, extraHosts)) {
            unsafeOption = true;
          }
        }
        break;
      }
      if (consumedArg || tok.startsWith('-')) continue;
    }
    positional.push(tok);
  }

  return { positional, extraHosts, unsafeOption };
}

function extractRemoteSpecHost(arg, { allowDoubleColon = false } = {}) {
  if (typeof arg !== 'string' || !arg) return { isRemote: false, host: null };

  // URI forms: scp://, sftp://, ssh://, rsync://
  if (/^(?:ssh|scp|sftp|rsync):\/\//i.test(arg)) {
    return { isRemote: true, host: normalizeHost(arg) };
  }

  // Bracketed IPv6 remote spec: [user@][2001:db8::1]:path
  const ipv6Match = /^(?:[^/@:\s]+@)?(\[[^\]]+\]):/.exec(arg);
  if (ipv6Match) {
    return { isRemote: true, host: normalizeHost(ipv6Match[1]) };
  }

  // rsync daemon syntax: [user@]host::module
  if (allowDoubleColon) {
    const dcIdx = arg.indexOf('::');
    if (dcIdx > 0 && !arg.slice(0, dcIdx).includes('/')) {
      return { isRemote: true, host: normalizeHost(arg.slice(0, dcIdx)) };
    }
  }

  // Standard [user@]host:path (exclude local paths with '/' before ':' and Windows drive letters)
  const colonIdx = arg.indexOf(':');
  if (colonIdx > 0) {
    const before = arg.slice(0, colonIdx);
    if (!before.includes('/') && !/^[A-Za-z]$/.test(before)) {
      return { isRemote: true, host: normalizeHost(before) };
    }
  }

  return { isRemote: false, host: null };
}

function checkSshTransport(seg, allowedHosts) {
  const { bin, rest } = stripWrappers(tokenize(seg));
  if (bin !== 'ssh' && bin !== 'scp' && bin !== 'sftp' && bin !== 'rsync') {
    return null;
  }

  if (bin === 'ssh') {
    const { positional, extraHosts, unsafeOption } = parseSshStyleArgs(rest, SSH_FLAGS_WITH_ARG);
    if (unsafeOption || positional.length === 0) {
      return { status: 'ask', reason: SSH_REASON };
    }
    const destHost = normalizeHost(positional[0]);
    if (!destHost) {
      return { status: 'ask', reason: SSH_REASON };
    }
    const allHosts = [destHost, ...extraHosts];
    if (allHosts.every((h) => allowedHosts.has(h))) {
      return { status: 'allow', hosts: allHosts };
    }
    return { status: 'ask', reason: SSH_REASON };
  }

  if (bin === 'sftp') {
    const { positional, extraHosts, unsafeOption } = parseSshStyleArgs(rest, SFTP_FLAGS_WITH_ARG);
    if (unsafeOption || positional.length === 0) {
      return { status: 'ask', reason: SSH_REASON };
    }
    const rawDest = positional[0];
    const spec = extractRemoteSpecHost(rawDest);
    const destHost = spec.isRemote ? spec.host : normalizeHost(rawDest);
    if (!destHost) {
      return { status: 'ask', reason: SSH_REASON };
    }
    const allHosts = [destHost, ...extraHosts];
    if (allHosts.every((h) => allowedHosts.has(h))) {
      return { status: 'allow', hosts: allHosts };
    }
    return { status: 'ask', reason: SSH_REASON };
  }

  if (bin === 'scp') {
    const { positional, extraHosts, unsafeOption } = parseSshStyleArgs(rest, SCP_FLAGS_WITH_ARG);
    if (unsafeOption || positional.length === 0) {
      return { status: 'ask', reason: SSH_REASON };
    }
    const remoteHosts = [...extraHosts];
    let foundRemote = false;
    for (const arg of positional) {
      const spec = extractRemoteSpecHost(arg);
      if (spec.isRemote) {
        foundRemote = true;
        if (!spec.host) return { status: 'ask', reason: SSH_REASON };
        remoteHosts.push(spec.host);
      }
    }
    if (!foundRemote) {
      return { status: 'ask', reason: SSH_REASON };
    }
    if (remoteHosts.every((h) => allowedHosts.has(h))) {
      return { status: 'allow', hosts: remoteHosts };
    }
    return { status: 'ask', reason: SSH_REASON };
  }

  // bin === 'rsync'
  const positional = [];
  const extraHosts = [];
  let unsafeOption = false;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (tok.startsWith('--')) {
      const eqIdx = tok.indexOf('=');
      const flag = eqIdx === -1 ? tok : tok.slice(0, eqIdx);
      let val = eqIdx === -1 ? null : tok.slice(eqIdx + 1);
      if (RSYNC_LONG_WITH_ARG.has(flag)) {
        if (val === null) {
          if (i + 1 < rest.length) val = rest[++i];
          else unsafeOption = true;
        }
        if (flag === '--rsh' && val) {
          const rshTokens = tokenize(val);
          const parsedRsh = parseSshStyleArgs(rshTokens.slice(1), SSH_FLAGS_WITH_ARG);
          if (parsedRsh.unsafeOption) unsafeOption = true;
          extraHosts.push(...parsedRsh.extraHosts);
        }
      }
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1) {
      for (let c = 1; c < tok.length; c++) {
        const ch = tok[c];
        if (!RSYNC_SHORT_WITH_ARG.has(ch)) continue;
        let val;
        if (c + 1 < tok.length) val = tok.slice(c + 1);
        else if (i + 1 < rest.length) val = rest[++i];
        else {
          unsafeOption = true;
          break;
        }
        if (ch === 'e' && val) {
          const rshTokens = tokenize(val);
          const parsedRsh = parseSshStyleArgs(rshTokens.slice(1), SSH_FLAGS_WITH_ARG);
          if (parsedRsh.unsafeOption) unsafeOption = true;
          extraHosts.push(...parsedRsh.extraHosts);
        }
        break;
      }
      continue;
    }
    positional.push(tok);
  }

  const remoteHosts = [...extraHosts];
  let foundRemote = false;
  for (const arg of positional) {
    const spec = extractRemoteSpecHost(arg, { allowDoubleColon: true });
    if (spec.isRemote) {
      foundRemote = true;
      if (!spec.host) return { status: 'ask', reason: SSH_REASON };
      remoteHosts.push(spec.host);
    }
  }

  // Local-only rsync (e.g. `rsync -av ./a ./b`) does not reach a remote host
  if (!foundRemote) {
    return null;
  }
  if (unsafeOption) {
    return { status: 'ask', reason: SSH_REASON };
  }
  if (remoteHosts.every((h) => allowedHosts.has(h))) {
    return { status: 'allow', hosts: remoteHosts };
  }
  return { status: 'ask', reason: SSH_REASON };
}

const DOCKER_HOST_ENV_REASON = 'sets `DOCKER_HOST` to target a non-default Docker daemon';
const DOCKER_FLAG_REASON = 'targets a remote Docker daemon (`-H` / `--host` / `--context`)';

function checkDockerRemote(seg, allowedHosts) {
  const tokens = tokenize(seg);
  const { bin, rest, envAssignments } = stripWrappers(tokens);

  let foundEnv = false;
  let foundFlag = false;
  const targets = [];
  let unparseable = false;

  // Check DOCKER_HOST=... in leading env assignments or `export DOCKER_HOST=...`
  for (const assign of envAssignments) {
    if (assign.startsWith('DOCKER_HOST=')) {
      foundEnv = true;
      const host = normalizeHost(assign.slice('DOCKER_HOST='.length));
      if (!host) unparseable = true;
      else targets.push(host);
    }
  }
  if (bin === 'export') {
    for (const tok of rest) {
      if (tok.startsWith('DOCKER_HOST=')) {
        foundEnv = true;
        const host = normalizeHost(tok.slice('DOCKER_HOST='.length));
        if (!host) unparseable = true;
        else targets.push(host);
      }
    }
  }

  // Check `docker -H / --host / --context`
  if (bin === 'docker') {
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok === '--') break;
      if (tok === '-H' || tok === '--host' || tok === '--context') {
        foundFlag = true;
        const val = rest[i + 1];
        i++;
        const host = normalizeHost(val);
        if (!host) unparseable = true;
        else targets.push(host);
        continue;
      }
      if (tok.startsWith('-H') && tok.length > 2) {
        foundFlag = true;
        const val = tok[2] === '=' ? tok.slice(3) : tok.slice(2);
        const host = normalizeHost(val);
        if (!host) unparseable = true;
        else targets.push(host);
        continue;
      }
      if (tok.startsWith('--host=')) {
        foundFlag = true;
        const host = normalizeHost(tok.slice('--host='.length));
        if (!host) unparseable = true;
        else targets.push(host);
        continue;
      }
      if (tok.startsWith('--context=')) {
        foundFlag = true;
        const host = normalizeHost(tok.slice('--context='.length));
        if (!host) unparseable = true;
        else targets.push(host);
        continue;
      }
    }
  }

  if (!foundEnv && !foundFlag) return null;

  const reason = foundFlag ? DOCKER_FLAG_REASON : DOCKER_HOST_ENV_REASON;
  if (unparseable || targets.length === 0) {
    return { status: 'ask', reason };
  }
  if (targets.every((h) => allowedHosts.has(h))) {
    return { status: 'allow', hosts: targets };
  }
  return { status: 'ask', reason };
}

const SEG_START = `(?:^|[;&|]+|\\$\\(|\\b(?:sudo|env|nohup|time|command|exec)\\s+)+\\s*`;
const atSegStart = (body) => new RegExp(`${SEG_START}${body}`, 'm');

const RULES = [
  {
    re: atSegStart(String.raw`crontab\s+-(?!l\b)[A-Za-z]*[erir]`),
    reason: 'modifies or removes the user crontab',
  },
  {
    re: atSegStart(String.raw`crontab\s+(?!-)\S`),
    reason: 'installs a new crontab from a file',
  },
  {
    re: atSegStart(String.raw`gh\s+(?!-\S+\s)*(?:pr|issue|release|repo|run|workflow|api|gist|label|secret|variable)\b(?!\s+(?:view|list|status|diff|checks|watch|search|clone)\b)`),
    reason: 'mutates GitHub state via `gh`',
  },
];

export function evaluateCommand(command, cwd = process.cwd(), options = {}, _depth = 0) {
  if (typeof command !== 'string' || !command.trim() || _depth > 10) {
    return { decision: 'allow', explicitAllow: false, reason: null };
  }

  const stripped = stripHeredocs(command);

  let activeCwd = cwd;
  let matchedAllowlistedRemote = false;
  let allSegmentsAllowlistedOrCd = true;
  const allowlistCache = new Map();

  const getCachedAllowedHosts = (dir) => {
    if (!allowlistCache.has(dir)) {
      allowlistCache.set(dir, getAllowedHosts(dir, options));
    }
    return allowlistCache.get(dir);
  };

  const segs = splitSegments(stripped);
  for (const seg of segs) {
    const cdTarget = parseCdSegment(seg);
    if (cdTarget) {
      activeCwd = path.resolve(activeCwd, cdTarget);
      continue;
    }

    // 1. Check extracted subshells ($( ... ) and ` ... `) in this segment recursively
    const subshells = extractSubshells(seg);
    for (const sub of subshells) {
      const subEval = evaluateCommand(sub, activeCwd, options, _depth + 1);
      if (subEval.decision === 'ask') return subEval;
      if (!subEval.explicitAllow) {
        allSegmentsAllowlistedOrCd = false;
      }
    }

    // 2. Check git push (resolves -C <dir> relative to activeCwd and checks rigged status)
    const pushReason = checkGitPush(seg, activeCwd);
    if (pushReason) {
      return { decision: 'ask', explicitAllow: false, reason: pushReason };
    }

    // 3. Check nested commands (bash -c, eval)
    const nested = parseNestedCommand(seg);
    if (nested) {
      const nestedEval = evaluateCommand(nested, activeCwd, options, _depth + 1);
      if (nestedEval.decision === 'ask') return nestedEval;
      if (nestedEval.explicitAllow) {
        matchedAllowlistedRemote = true;
      } else {
        allSegmentsAllowlistedOrCd = false;
      }
      continue;
    }

    // 4. Enforce general remote/shared-state rules only when activeCwd is in a rigged repository
    // (governed by docs/adr/0004-strict-unrigged-repository-isolation.md).
    if (isDirectoryInRiggedRepo(activeCwd)) {
      const rigAllowReason = checkRigAllowMutation(seg);
      if (rigAllowReason) {
        return { decision: 'ask', explicitAllow: false, reason: rigAllowReason };
      }

      const allowedHosts = getCachedAllowedHosts(activeCwd);
      let segAllowlisted = false;

      const sshRes = checkSshTransport(seg, allowedHosts);
      if (sshRes) {
        if (sshRes.status === 'ask') {
          return { decision: 'ask', explicitAllow: false, reason: sshRes.reason };
        }
        segAllowlisted = true;
        matchedAllowlistedRemote = true;
      }

      const dockerRes = checkDockerRemote(seg, allowedHosts);
      if (dockerRes) {
        if (dockerRes.status === 'ask') {
          return { decision: 'ask', explicitAllow: false, reason: dockerRes.reason };
        }
        segAllowlisted = true;
        matchedAllowlistedRemote = true;
      }

      const scrubbed = maskQuotes(seg);
      for (const { re, reason } of RULES) {
        if (re.test(scrubbed)) {
          return { decision: 'ask', explicitAllow: false, reason };
        }
      }

      if (!segAllowlisted) {
        allSegmentsAllowlistedOrCd = false;
      }
    } else {
      allSegmentsAllowlistedOrCd = false;
    }
  }

  if (matchedAllowlistedRemote && allSegmentsAllowlistedOrCd) {
    return {
      decision: 'allow',
      explicitAllow: true,
      reason: 'Remote host is explicitly allowlisted by agent-rig.',
    };
  }

  return { decision: 'allow', explicitAllow: false, reason: null };
}

export function checkCommand(command, cwd = process.cwd(), optionsOrDepth = 0) {
  const options = typeof optionsOrDepth === 'object' && optionsOrDepth !== null ? optionsOrDepth : {};
  const depth = typeof optionsOrDepth === 'number' ? optionsOrDepth : 0;
  const res = evaluateCommand(command, cwd, options, depth);
  return res.decision === 'ask' ? res.reason : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let parsed;
  try {
    parsed = readHookInput();
  } catch {
    process.exit(0);
  }
  try {
    const res = evaluateCommand(parsed.command, parsed.cwd);
    if (res.decision === 'ask') {
      emitDecision(parsed.schema, 'ask', `Remote/shared state guard: command ${res.reason}. Confirm with the user before running.`);
    } else {
      emitDecision(parsed.schema, 'allow', res.reason, { explicitAllow: res.explicitAllow });
    }
  } catch {
    emitDecision(parsed.schema, 'allow');
  }
}
