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
import { loadDenyPolicy, isRuleEnabled } from './lib/deny-policy.mjs';
import {
  stripHeredocs,
  maskQuotes,
  tokenize,
  stripWrappers,
  parseCdSegment,
  parseNestedCommand,
  extractSubshells,
  parseCommandLists,
} from './lib/shell-parser.mjs';

function toTokens(segOrTokens) {
  return Array.isArray(segOrTokens) ? segOrTokens : tokenize(segOrTokens);
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

function checkGitPush(segOrTokens, cwd) {
  const tokens = toTokens(segOrTokens);
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
function checkRigAllowMutation(segOrTokens) {
  const { bin, rest } = stripWrappers(toTokens(segOrTokens));
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

function checkSshTransport(segOrTokens, allowedHosts) {
  const { bin, rest } = stripWrappers(toTokens(segOrTokens));
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

function checkDockerRemote(segOrTokens, allowedHosts) {
  const tokens = toTokens(segOrTokens);
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

const ANSIBLE_VALUE_FLAGS = new Set([
  '-e', '--extra-vars', '-i', '--inventory', '--inventory-file',
  '-u', '--user', '-l', '--limit', '-t', '--tags', '--skip-tags',
  '--vault-password-file', '--vault-id', '-M', '--module-path',
  '-f', '--forks', '--private-key', '--key-file', '-T', '--timeout',
  '-c', '--connection', '-m', '--module-name', '-a', '--args',
  '--become-method', '--become-user', '--ssh-common-args',
  '--sftp-extra-args', '--scp-extra-args', '--ssh-extra-args',
  '--start-at-task', '-B', '--background', '-P', '--poll',
]);
const ANSIBLE_OFFLINE_FLAGS = new Set([
  '--syntax-check', '--version', '--help', '-h',
  '--list-tasks', '--list-tags', '--list-hosts',
]);

const TERRAFORM_DIR_FLAGS = new Set(['-chdir', '--terragrunt-working-dir', '--working-dir']);
const TERRAFORM_VALUE_FLAGS = new Set([
  '-chdir', '--terragrunt-working-dir', '--working-dir',
  '--terragrunt-config', '--config', '--terragrunt-tfpath', '--terragrunt-download-dir',
  '--terragrunt-iam-role', '--terragrunt-iam-assume-role-duration',
  '--terragrunt-iam-assume-role-session-name', '--terragrunt-source',
  '--terragrunt-include-dir', '--terragrunt-exclude-dir',
  '--terragrunt-log-level', '--log-level',
  '-var', '-var-file', '-backend', '--backend', '-backend-config',
  '-target', '-out', '-state', '-state-out', '-backup',
  '-lock-timeout', '-parallelism', '-plugin-dir', '-platform',
]);
const TERRAFORM_OFFLINE_SUBS = new Set([
  'validate', 'fmt', 'hclfmt', 'version', 'providers',
  'graph', 'show', 'output', 'validate-inputs', 'graph-dependencies',
]);

const KUBECTL_VALUE_FLAGS = new Set([
  '-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user',
  '-s', '--server', '--as', '--as-group', '--as-uid', '-v', '--v',
  '-o', '--output', '--request-timeout', '--cache-dir', '--token',
  '--username', '--password', '--client-certificate', '--client-key',
  '--certificate-authority', '--tls-server-name', '--vmodule',
  '--log-dir', '--log-file', '--profile', '--profile-output',
  '--match-server-version', '-f', '--filename', '-k', '--kustomize',
  '-l', '--selector', '--field-selector', '--dry-run',
  '-c', '--container', '--sort-by', '--template',
  '--kube-apiserver', '--registry-config', '--repository-cache', '--repository-config',
]);
const KUBECTL_READ_SUBS = new Set([
  'get', 'describe', 'logs', 'top', 'events', 'explain',
  'diff', 'wait', 'api-resources', 'api-versions', 'cluster-info',
]);
const KUBECTL_OFFLINE_CONFIG_SUBS = new Set([
  'current-context', 'get-contexts', 'get-clusters', 'get-users', 'view',
]);

const HELM_VALUE_FLAGS = new Set([
  '-n', '--namespace', '--kube-context', '--kubeconfig', '--kube-apiserver',
  '--kube-as-user', '--kube-as-group', '--kube-ca-file', '--kube-token',
  '--kube-tls-server-name', '--registry-config', '--repository-cache',
  '--repository-config', '--content-cache', '--burst-limit', '--qps',
  '-o', '--output', '-f', '--values', '--set', '--set-string',
  '--set-file', '--set-json', '--set-literal', '--version', '--repo',
  '--username', '--password', '--ca-file', '--cert-file', '--key-file',
  '--timeout', '--description', '--post-renderer', '-l', '--selector',
]);
const HELM_OFFLINE_SUBS = new Set([
  'help', 'lint', 'template', 'show', 'inspect', 'search',
  'version', 'env', 'verify', 'create', 'package', 'completion',
]);
const HELM_READ_SUBS = new Set(['list', 'ls', 'status', 'history', 'get']);

const RCLONE_VALUE_FLAGS = new Set([
  '--config', '--log-file', '--log-level', '--log-format',
  '--filter', '--filter-from', '--include', '--include-from',
  '--exclude', '--exclude-from', '--files-from', '--files-from-raw',
  '--transfers', '--checkers', '--bwlimit', '--tpslimit', '--user-agent',
  '--addr', '--baseurl', '--bind', '--rc-addr', '--rc-user', '--rc-pass',
  '--password-command', '--cache-dir', '--temp-dir', '--backup-dir',
  '--suffix', '--compare-dest', '--copy-dest', '--max-age', '--min-age',
  '--max-size', '--min-size', '--max-depth', '--contimeout', '--timeout',
  '--order-by', '--stats', '--stats-unit', '--header',
  '--header-download', '--header-upload', '--dump', '--rc-files', '-o', '--output',
]);
const RCLONE_LOCAL_SUBS = new Set(['version', 'help', 'listremotes', 'obscure', 'genautocomplete']);
const RCLONE_READ_SUBS = new Set([
  'ls', 'lsd', 'lsf', 'lsl', 'lsjson', 'md5sum', 'sha1sum',
  'hashsum', 'size', 'stat', 'about', 'check', 'cryptcheck', 'tree', 'ncdu',
]);

function consumeFlagArg(rest, index, valueFlags) {
  const tok = rest[index];
  const eqIdx = tok.indexOf('=');
  const flag = eqIdx === -1 ? tok : tok.slice(0, eqIdx);
  const inlineVal = eqIdx === -1 ? null : tok.slice(eqIdx + 1);
  if (eqIdx === -1 && valueFlags.has(flag) && index + 1 < rest.length) {
    return { flag, value: rest[index + 1], nextIndex: index + 1 };
  }
  return { flag, value: inlineVal, nextIndex: index };
}

/**
 * Checks `ansible` / `ansible-playbook` invocations under `@remote:ansible`
 * (governed by docs/adr/0006-configurable-deny-policy-and-secops-guards.md Decision 5).
 */
function checkAnsible(tokens, policy) {
  const { bin, rest } = stripWrappers(tokens);
  if (bin !== 'ansible' && bin !== 'ansible-playbook') return null;
  if (!isRuleEnabled(policy, 'remote:ansible')) return null;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') break;
    if (ANSIBLE_OFFLINE_FLAGS.has(tok)) return null;
    if (tok.startsWith('-') && tok !== '-') {
      i = consumeFlagArg(rest, i, ANSIBLE_VALUE_FLAGS).nextIndex;
    }
  }

  return `runs Ansible (\`${bin}\`) against managed hosts (\`@remote:ansible\`)`;
}

/**
 * Checks `terraform` / `tofu` / `terragrunt` invocations under `@remote:terraform` and
 * `@remote:terraform-plan`, resolving `-chdir` and `--terragrunt-working-dir` before
 * checking rigged isolation (governed by docs/adr/0006-configurable-deny-policy-and-secops-guards.md Decision 5).
 */
function checkTerraformRemote(tokens, activeCwd, getPolicy) {
  const { bin, rest } = stripWrappers(tokens);
  if (bin !== 'terraform' && bin !== 'tofu' && bin !== 'terragrunt') return null;

  let effectiveCwd = activeCwd;
  let hasHelpOrVersion = false;
  let hasShortVBeforeSub = false;
  let hasBackendFalse = false;
  const positional = [];

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (tok.startsWith('-') && tok !== '-') {
      const { flag, value, nextIndex } = consumeFlagArg(rest, i, TERRAFORM_VALUE_FLAGS);
      i = nextIndex;
      if (TERRAFORM_DIR_FLAGS.has(flag) && value) {
        effectiveCwd = path.resolve(activeCwd, value);
      } else if ((flag === '-backend' || flag === '--backend') && value === 'false') {
        hasBackendFalse = true;
      } else if (
        flag === '--help' ||
        flag === '-h' ||
        flag === '-help' ||
        flag === '--version' ||
        flag === '-version'
      ) {
        hasHelpOrVersion = true;
      } else if (flag === '-v' && positional.length === 0) {
        hasShortVBeforeSub = true;
      }
      continue;
    }
    positional.push(tok);
  }

  if (!isDirectoryInRiggedRepo(effectiveCwd)) return null;
  if (hasHelpOrVersion || hasShortVBeforeSub || positional.length === 0) return null;

  const policy = getPolicy(effectiveCwd);
  let effectivePos = positional;
  if (bin === 'terragrunt' && (effectivePos[0] === 'run-all' || effectivePos[0] === 'run')) {
    effectivePos = effectivePos.slice(1);
  }

  const sub = effectivePos[0];
  const sub2 = effectivePos[1];

  if (sub && TERRAFORM_OFFLINE_SUBS.has(sub)) return null;
  if (sub === 'init' && hasBackendFalse) return null;
  if (sub === 'workspace' && (sub2 === 'list' || sub2 === 'show')) return null;
  if (sub === 'state' && (sub2 === 'list' || sub2 === 'show')) return null;
  if (bin === 'terragrunt' && sub === 'hcl' && (sub2 === 'fmt' || sub2 === 'validate')) return null;

  if (sub === 'plan') {
    if (!isRuleEnabled(policy, 'remote:terraform-plan')) return null;
    return `runs \`${bin} plan\` against remote state/providers (\`@remote:terraform-plan\`)`;
  }

  if (!isRuleEnabled(policy, 'remote:terraform')) return null;
  const label = sub
    ? `${bin} ${sub}${sub2 && (sub === 'workspace' || sub === 'state') ? ` ${sub2}` : ''}`
    : bin;
  return `runs \`${label}\` modifying infrastructure or remote state (\`@remote:terraform\`)`;
}

/**
 * Checks `kubectl` invocations under `@remote:kubectl` and `@remote:kubectl-read`
 * (governed by docs/adr/0006-configurable-deny-policy-and-secops-guards.md Decision 5).
 */
function checkKubectl(tokens, policy) {
  const { bin, rest } = stripWrappers(tokens);
  if (bin !== 'kubectl') return null;

  let hasHelp = false;
  let dryRunMode = null;
  let hasClientFlag = false;
  const positional = [];

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (tok.startsWith('-') && tok !== '-') {
      const { flag, value, nextIndex } = consumeFlagArg(rest, i, KUBECTL_VALUE_FLAGS);
      i = nextIndex;
      if (flag === '--help' || flag === '-h') {
        hasHelp = true;
      } else if (flag === '--dry-run' && value !== null) {
        dryRunMode = value.toLowerCase();
      } else if (flag === '--client' && (value === null || value.toLowerCase() === 'true')) {
        hasClientFlag = true;
      }
      continue;
    }
    positional.push(tok);
  }

  const sub = positional[0];
  const sub2 = positional[1];

  if (hasHelp || !sub || sub === 'help') return null;
  if (dryRunMode === 'client') return null;
  if (sub === 'version' && hasClientFlag) return null;
  if (sub === 'config' && sub2 && KUBECTL_OFFLINE_CONFIG_SUBS.has(sub2)) return null;

  const isReadOnly =
    KUBECTL_READ_SUBS.has(sub) ||
    sub === 'version' ||
    (sub === 'auth' && (sub2 === 'can-i' || sub2 === 'whoami')) ||
    (sub === 'rollout' && (sub2 === 'status' || sub2 === 'history'));

  if (isReadOnly) {
    if (!isRuleEnabled(policy, 'remote:kubectl-read')) return null;
    const label = sub2 && (sub === 'auth' || sub === 'rollout') ? `${sub} ${sub2}` : sub;
    return `queries a live Kubernetes cluster via \`kubectl ${label}\` (\`@remote:kubectl-read\`)`;
  }

  if (!isRuleEnabled(policy, 'remote:kubectl')) return null;
  const label = sub2 && (sub === 'auth' || sub === 'rollout' || sub === 'config') ? `${sub} ${sub2}` : sub;
  return `mutates or connects to a Kubernetes cluster via \`kubectl ${label}\` (\`@remote:kubectl\`)`;
}

/**
 * Checks `helm` invocations under `@remote:helm` and `@remote:helm-read`
 * (governed by docs/adr/0006-configurable-deny-policy-and-secops-guards.md Decision 5).
 */
function checkHelm(tokens, policy) {
  const { bin, rest } = stripWrappers(tokens);
  if (bin !== 'helm') return null;

  let hasHelp = false;
  let dryRunMode = null;
  const positional = [];

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (tok.startsWith('-') && tok !== '-') {
      if (tok === '--dry-run') {
        dryRunMode = 'client';
        continue;
      }
      const { flag, value, nextIndex } = consumeFlagArg(rest, i, HELM_VALUE_FLAGS);
      i = nextIndex;
      if (flag === '--help' || flag === '-h') {
        hasHelp = true;
      } else if (flag === '--dry-run' && value !== null) {
        dryRunMode = value.toLowerCase();
      }
      continue;
    }
    positional.push(tok);
  }

  const sub = positional[0];
  const sub2 = positional[1];

  if (hasHelp || !sub || HELM_OFFLINE_SUBS.has(sub)) return null;
  if ((sub === 'dependency' || sub === 'dep') && (sub2 === 'list' || sub2 === 'ls')) return null;
  if (dryRunMode === 'client' || dryRunMode === 'true') return null;

  if (HELM_READ_SUBS.has(sub)) {
    if (!isRuleEnabled(policy, 'remote:helm-read')) return null;
    return `queries live Helm releases via \`helm ${sub}\` (\`@remote:helm-read\`)`;
  }

  if (!isRuleEnabled(policy, 'remote:helm')) return null;
  const label = sub2 && (sub === 'dependency' || sub === 'dep') ? `${sub} ${sub2}` : sub;
  return `mutates Helm releases or repositories via \`helm ${label}\` (\`@remote:helm\`)`;
}

function isRcloneRemoteSpec(arg) {
  if (typeof arg !== 'string' || !arg) return false;
  if (arg.startsWith(':') && arg.length > 1) return true;
  const colonIdx = arg.indexOf(':');
  if (colonIdx <= 0) return false;
  const before = arg.slice(0, colonIdx);
  if (before.includes('/') || /^[A-Za-z]$/.test(before)) return false;
  return true;
}

/**
 * Checks `rclone` invocations under `@remote:rclone` and `@remote:rclone-read`
 * (governed by docs/adr/0006-configurable-deny-policy-and-secops-guards.md Decision 5).
 */
function checkRclone(tokens, policy) {
  const { bin, rest } = stripWrappers(tokens);
  if (bin !== 'rclone') return null;

  let hasHelpOrVersion = false;
  const positional = [];

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (tok.startsWith('-') && tok !== '-') {
      const { flag, nextIndex } = consumeFlagArg(rest, i, RCLONE_VALUE_FLAGS);
      i = nextIndex;
      if (flag === '--help' || flag === '-h' || flag === '--version' || flag === '-V') {
        hasHelpOrVersion = true;
      }
      continue;
    }
    positional.push(tok);
  }

  const sub = positional[0];
  if (hasHelpOrVersion || !sub || RCLONE_LOCAL_SUBS.has(sub)) return null;

  const hasRemoteTarget = positional.slice(1).some(isRcloneRemoteSpec);
  if (!hasRemoteTarget) return null;

  if (RCLONE_READ_SUBS.has(sub)) {
    if (!isRuleEnabled(policy, 'remote:rclone-read')) return null;
    return `reads remote storage via \`rclone ${sub}\` (\`@remote:rclone-read\`)`;
  }

  if (!isRuleEnabled(policy, 'remote:rclone')) return null;
  return `accesses or mutates remote storage via \`rclone ${sub}\` (\`@remote:rclone\`)`;
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

export function evaluateCommand(command, cwd = process.cwd(), options = {}, _depth = 0, _state = null) {
  if (typeof command !== 'string' || !command.trim() || _depth > 10) {
    return { decision: 'allow', explicitAllow: false, reason: null };
  }

  const stripped = stripHeredocs(command);

  let activeCwd = cwd;
  let matchedAllowlistedRemote = false;
  let allSegmentsAllowlistedOrCd = true;
  const state = _state ?? { allowlistCache: new Map(), policyCache: new Map() };

  const getCachedAllowedHosts = (dir) => {
    if (!state.allowlistCache.has(dir)) {
      state.allowlistCache.set(dir, getAllowedHosts(dir, options));
    }
    return state.allowlistCache.get(dir);
  };

  const getCachedPolicy = (dir) => {
    const key = path.resolve(dir || cwd || process.cwd());
    if (!state.policyCache.has(key)) {
      state.policyCache.set(
        key,
        loadDenyPolicy({ cwd: key, homeDir: options.homeDir, rigRoot: options.rigRoot }),
      );
    }
    return state.policyCache.get(key);
  };

  const lists = parseCommandLists(stripped);
  for (const list of lists) {
    if (list.stages.length === 1) {
      const cdTarget = parseCdSegment(list.stages[0].tokens);
      if (cdTarget) {
        activeCwd = path.resolve(activeCwd, cdTarget);
        continue;
      }
    }

    for (const stage of list.stages) {
      const seg = stage.raw;
      const tokens = stage.tokens;

      // 1. Check extracted subshells ($( ... ) and ` ... `) in this stage recursively
      const subshells = extractSubshells(seg);
      for (const sub of subshells) {
        const subEval = evaluateCommand(sub, activeCwd, options, _depth + 1, state);
        if (subEval.decision === 'ask') return subEval;
        if (!subEval.explicitAllow) {
          allSegmentsAllowlistedOrCd = false;
        }
      }

      // 2. Check git push and terraform/tofu/terragrunt (both resolve target dirs relative to activeCwd)
      const pushReason = checkGitPush(tokens, activeCwd);
      if (pushReason) {
        return { decision: 'ask', explicitAllow: false, reason: pushReason };
      }

      const terraformReason = checkTerraformRemote(tokens, activeCwd, getCachedPolicy);
      if (terraformReason) {
        return { decision: 'ask', explicitAllow: false, reason: terraformReason };
      }

      // 3. Check nested commands (bash -c, eval)
      const nested = parseNestedCommand(tokens);
      if (nested) {
        const nestedEval = evaluateCommand(nested, activeCwd, options, _depth + 1, state);
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
        const rigAllowReason = checkRigAllowMutation(tokens);
        if (rigAllowReason) {
          return { decision: 'ask', explicitAllow: false, reason: rigAllowReason };
        }

        const allowedHosts = getCachedAllowedHosts(activeCwd);
        let segAllowlisted = false;

        const sshRes = checkSshTransport(tokens, allowedHosts);
        if (sshRes) {
          if (sshRes.status === 'ask') {
            return { decision: 'ask', explicitAllow: false, reason: sshRes.reason };
          }
          segAllowlisted = true;
          matchedAllowlistedRemote = true;
        }

        const dockerRes = checkDockerRemote(tokens, allowedHosts);
        if (dockerRes) {
          if (dockerRes.status === 'ask') {
            return { decision: 'ask', explicitAllow: false, reason: dockerRes.reason };
          }
          segAllowlisted = true;
          matchedAllowlistedRemote = true;
        }

        const policy = getCachedPolicy(activeCwd);
        const iacReason =
          checkAnsible(tokens, policy) ||
          checkKubectl(tokens, policy) ||
          checkHelm(tokens, policy) ||
          checkRclone(tokens, policy);
        if (iacReason) {
          return { decision: 'ask', explicitAllow: false, reason: iacReason };
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
