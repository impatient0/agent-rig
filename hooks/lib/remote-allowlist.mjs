import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { existingAncestor, resolveGitRoots } from './hook-io.mjs';

export const ALLOWED_REMOTES_FILENAME = 'allowed-remotes.json';
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const DURATION_RE = /^(\d+(?:\.\d+)?)(s|m|h|d)$/i;
const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Parses a human duration string such as `30m`, `4h`, `24h`, or `7d` into milliseconds.
 */
export function parseDurationMs(input) {
  if (typeof input !== 'string') {
    throw new Error(`Invalid TTL duration: ${String(input)}. Expected <number>(s|m|h|d), e.g. 4h or 24h.`);
  }
  const trimmed = input.trim();
  const match = DURATION_RE.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid TTL duration '${input}'. Expected <number>(s|m|h|d), e.g. 30m, 4h, 24h, or 7d.`);
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = Math.round(value * UNIT_MS[unit]);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`TTL duration '${input}' must be greater than 0.`);
  }
  return ms;
}

/**
 * Normalizes a host or endpoint token (e.g. `user@host`, `ssh://user@host:2222`,
 * `[2001:db8::1]:22`, `tcp://host:2375`) to a canonical lowercase hostname.
 * Returns null if the input is empty, contains shell expansions, wildcards, or invalid syntax.
 */
export function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;

  // Reject shell variables, command substitutions, wildcards, or whitespace
  if (/[\s$*?`\\'"|;&<>()]/.test(value)) return null;

  // Strip URI scheme if present (ssh://, sftp://, scp://, rsync://, tcp://, http://, https://)
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(value);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'unix' || scheme === 'npipe' || scheme === 'fd') {
      return null;
    }
    value = schemeMatch[2];
    // Strip path component after host[:port]
    const slashIdx = value.indexOf('/');
    if (slashIdx !== -1) {
      value = value.slice(0, slashIdx);
    }
  }

  // Strip user@ prefix
  const atIdx = value.lastIndexOf('@');
  if (atIdx !== -1) {
    value = value.slice(atIdx + 1);
  }

  if (!value) return null;

  // Handle bracketed IPv6: [2001:db8::1] or [2001:db8::1]:22
  if (value.startsWith('[')) {
    const closeIdx = value.indexOf(']');
    if (closeIdx === -1) return null;
    const inside = value.slice(1, closeIdx);
    const trailing = value.slice(closeIdx + 1);
    if (trailing && !/^:\d+$/.test(trailing)) return null;
    if (!inside || /[\s$*?`\\]/.test(inside)) return null;
    return inside.toLowerCase();
  }

  // Strip trailing :port for IPv4 / DNS / SSH aliases (leave bare IPv6 with multiple colons intact)
  const firstColon = value.indexOf(':');
  const lastColon = value.lastIndexOf(':');
  if (firstColon !== -1 && firstColon === lastColon) {
    const portPart = value.slice(firstColon + 1);
    if (!/^\d+$/.test(portPart)) return null;
    value = value.slice(0, firstColon);
  }

  if (!value || value.startsWith('-') || value.includes('/')) return null;
  return value.toLowerCase();
}

/**
 * Resolves `<git-common-dir>/rig/allowed-remotes.json` for a directory inside a git repo,
 * or null if the directory is not inside a git repository.
 */
export function getAllowedRemotesPath(dir = process.cwd()) {
  const ancestor = existingAncestor(dir, process.cwd());
  if (!ancestor) return null;
  const roots = resolveGitRoots(ancestor);
  if (!roots || !roots.commonDir) return null;
  return path.join(roots.commonDir, 'rig', ALLOWED_REMOTES_FILENAME);
}

function readRawAllowlistFile(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return { version: 1, hosts: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object') {
      return { version: 1, hosts: { ...parsed.hosts } };
    }
  } catch {
    // Treat malformed file as empty (fail closed)
  }
  return { version: 1, hosts: {} };
}

/**
 * Reads active (non-expired) repo-scoped allowed remote hosts from `<git-common-dir>/rig/allowed-remotes.json`.
 */
export function readRepoAllowlist(dir = process.cwd(), { now = Date.now() } = {}) {
  const filePath = getAllowedRemotesPath(dir);
  const active = new Map();
  const expired = new Map();
  if (!filePath) {
    return { filePath: null, active, expired };
  }

  const data = readRawAllowlistFile(filePath);
  for (const [rawHost, entry] of Object.entries(data.hosts)) {
    const host = normalizeHost(rawHost);
    if (!host || !entry || typeof entry !== 'object') continue;
    const expiresAt = typeof entry.expiresAt === 'string' ? entry.expiresAt : null;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : null;
    if (expiresAt !== null && (!Number.isFinite(expiresMs) || expiresMs <= now)) {
      expired.set(host, {
        host,
        addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null,
        expiresAt,
      });
      continue;
    }
    active.set(host, {
      host,
      addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null,
      expiresAt,
      remainingMs: expiresMs !== null ? Math.max(0, expiresMs - now) : null,
    });
  }

  return { filePath, active, expired };
}

/**
 * Parses `~/.ssh/config` for exact, non-wildcard `Host <alias>` stanzas annotated
 * with `# agent-rig: allow` (either on the `Host` line or inside the stanza).
 */
export function readSshConfigAllowlist({
  homeDir = homedir(),
  sshConfigPath = path.join(homeDir, '.ssh', 'config'),
} = {}) {
  const hosts = new Set();
  if (!sshConfigPath || !existsSync(sshConfigPath)) {
    return hosts;
  }

  let content;
  try {
    content = readFileSync(sshConfigPath, 'utf8');
  } catch {
    return hosts;
  }

  const ALLOW_MARKER_RE = /#\s*agent-rig:\s*allow\b/i;
  let currentHosts = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      if (currentHosts.length > 0 && ALLOW_MARKER_RE.test(trimmed)) {
        for (const h of currentHosts) hosts.add(h);
      }
      continue;
    }

    const commentIdx = rawLine.indexOf('#');
    const codePart = (commentIdx === -1 ? rawLine : rawLine.slice(0, commentIdx)).trim();
    const commentPart = commentIdx === -1 ? '' : rawLine.slice(commentIdx);

    const kwMatch = /^([A-Za-z]+)(?:\s+|\s*=\s*)(.*)$/.exec(codePart);
    if (!kwMatch) continue;

    const keyword = kwMatch[1].toLowerCase();
    const rest = kwMatch[2].trim();

    if (keyword === 'host') {
      const patterns = rest.split(/\s+/).filter(Boolean);
      const exactHosts = [];
      for (const pat of patterns) {
        if (pat.startsWith('!') || pat.includes('*') || pat.includes('?')) continue;
        const normalized = normalizeHost(pat);
        if (normalized) exactHosts.push(normalized);
      }
      currentHosts = exactHosts;
      if (currentHosts.length > 0 && ALLOW_MARKER_RE.test(commentPart)) {
        for (const h of currentHosts) hosts.add(h);
      }
      continue;
    }

    if (keyword === 'match') {
      // Do not inherit Host aliases into Match blocks
      currentHosts = [];
      continue;
    }

    if (currentHosts.length > 0 && ALLOW_MARKER_RE.test(commentPart)) {
      for (const h of currentHosts) hosts.add(h);
    }
  }

  return hosts;
}

/**
 * Returns the union of active repo-scoped allowed hosts and `~/.ssh/config` marked hosts.
 */
export function getAllowedHosts(dir = process.cwd(), { now = Date.now(), homeDir = homedir(), sshConfigPath } = {}) {
  const { active } = readRepoAllowlist(dir, { now });
  const sshHosts = readSshConfigAllowlist({
    homeDir,
    sshConfigPath: sshConfigPath ?? path.join(homeDir, '.ssh', 'config'),
  });
  const merged = new Set(active.keys());
  for (const host of sshHosts) {
    merged.add(host);
  }
  return merged;
}

/**
 * Adds or updates a repo-scoped allowed remote host in `<git-common-dir>/rig/allowed-remotes.json`.
 */
export function allowRemoteHost(
  dir = process.cwd(),
  rawHost,
  { ttlMs = DEFAULT_TTL_MS, permanent = false, now = Date.now() } = {},
) {
  const host = normalizeHost(rawHost);
  if (!host) {
    throw new Error(`Invalid remote host '${rawHost}'. Provide an exact hostname, SSH alias, or IP address (no wildcards).`);
  }

  const filePath = getAllowedRemotesPath(dir);
  if (!filePath) {
    throw new Error(`Target directory is not inside a git repository: ${path.resolve(dir || process.cwd())}`);
  }

  const data = readRawAllowlistFile(filePath);

  // Prune already-expired entries on write
  for (const [k, v] of Object.entries(data.hosts)) {
    if (v && typeof v.expiresAt === 'string') {
      const exp = Date.parse(v.expiresAt);
      if (!Number.isFinite(exp) || exp <= now) {
        delete data.hosts[k];
      }
    }
  }

  const addedAt = new Date(now).toISOString();
  const expiresAt = permanent ? null : new Date(now + ttlMs).toISOString();
  data.hosts[host] = { addedAt, expiresAt };

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');

  return {
    host,
    filePath,
    addedAt,
    expiresAt,
    permanent,
  };
}

/**
 * Revokes a repo-scoped allowed remote host from `<git-common-dir>/rig/allowed-remotes.json`.
 */
export function revokeRemoteHost(dir = process.cwd(), rawHost, { now = Date.now() } = {}) {
  const host = normalizeHost(rawHost);
  if (!host) {
    throw new Error(`Invalid remote host '${rawHost}'.`);
  }

  const filePath = getAllowedRemotesPath(dir);
  if (!filePath) {
    throw new Error(`Target directory is not inside a git repository: ${path.resolve(dir || process.cwd())}`);
  }

  const data = readRawAllowlistFile(filePath);
  let removed = false;
  for (const key of Object.keys(data.hosts)) {
    if (normalizeHost(key) === host) {
      delete data.hosts[key];
      removed = true;
    }
  }

  // Prune expired entries too
  for (const [k, v] of Object.entries(data.hosts)) {
    if (v && typeof v.expiresAt === 'string') {
      const exp = Date.parse(v.expiresAt);
      if (!Number.isFinite(exp) || exp <= now) {
        delete data.hosts[k];
      }
    }
  }

  if (existsSync(filePath) || removed) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  return { host, filePath, removed };
}

/**
 * Clears all repo-scoped allowed remote hosts from `<git-common-dir>/rig/allowed-remotes.json`.
 */
export function clearRemoteHosts(dir = process.cwd()) {
  const filePath = getAllowedRemotesPath(dir);
  if (!filePath) {
    throw new Error(`Target directory is not inside a git repository: ${path.resolve(dir || process.cwd())}`);
  }

  const data = readRawAllowlistFile(filePath);
  const count = Object.keys(data.hosts).length;
  if (existsSync(filePath) || count > 0) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ version: 1, hosts: {} }, null, 2) + '\n', 'utf8');
  }

  return { filePath, clearedCount: count };
}

/**
 * Lists active repo-scoped allowed remote hosts and `~/.ssh/config` marked hosts.
 */
export function listAllowedRemotes(
  dir = process.cwd(),
  { now = Date.now(), homeDir = homedir(), sshConfigPath } = {},
) {
  const { filePath, active } = readRepoAllowlist(dir, { now });
  const resolvedSshConfig = sshConfigPath ?? path.join(homeDir, '.ssh', 'config');
  const sshHosts = [...readSshConfigAllowlist({ homeDir, sshConfigPath: resolvedSshConfig })].sort();

  const repoHosts = [...active.values()].sort((a, b) => a.host.localeCompare(b.host));

  return {
    repoPath: filePath,
    repoHosts,
    sshConfigPath: resolvedSshConfig,
    sshConfigHosts: sshHosts,
  };
}
