#!/usr/bin/env node
// CLI for agent-rig:
//   rig install [--harnesses antigravity,claude,...] [--detected] [--home <dir>] [--force]
//   rig update [--all] [--repo <target-dir>] [--home <dir>] [--harness <id>]
//   rig profile [list] [--json]
//   rig profile use <profile-name>
//   rig profile set <role> <model> [--effort <low|medium|high|max>] [--subagent-model <selector>] [--profile <name>] [--harness <id>]
//   rig model resolve <role> [--harness <id>] [--profile <name>] [--json]
//   rig init [<target-dir>] [--self-contained] [--no-worktrees] [--ui] [--force] [--harness <id>]
//   rig attach [<target-dir>] [--home <dir>] [--force]
//   rig eject [<target-dir>] [--home <dir>]
//   rig hook pre-commit [<target-dir>]
//   rig check-docs [<target-dir>] [--fix]
//   rig reflow-docs [<target-dir>] [--check]
//   rig status [<target-dir>]

import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  statSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MANAGED_AGENTS_START,
  MANAGED_AGENTS_END,
  MANAGED_AGENTS_HEADER,
  MANAGED_DOCS_START,
  MANAGED_DOCS_END,
  MANAGED_DOCS_HEADER,
  extractManagedAgentsBlock,
  parseAdrStatus,
  isEphemeralDoc,
  parseDocFrontmatter,
  isCollectionDir,
  findCollectionDirs,
  buildCollectionDocsIndexBlock,
  buildDocsIndexBlock,
  updateDocManagedDocsBlock,
  extractManagedDocsBlock,
  mergeManagedAgentsFile,
} from '../scripts/check-doc-links.mjs';

export {
  MANAGED_AGENTS_START,
  MANAGED_AGENTS_END,
  MANAGED_AGENTS_HEADER,
  MANAGED_DOCS_START,
  MANAGED_DOCS_END,
  MANAGED_DOCS_HEADER,
  extractManagedAgentsBlock,
  parseAdrStatus,
  isEphemeralDoc,
  parseDocFrontmatter,
  isCollectionDir,
  findCollectionDirs,
  buildCollectionDocsIndexBlock,
  buildDocsIndexBlock,
  updateDocManagedDocsBlock,
  extractManagedDocsBlock,
  mergeManagedAgentsFile,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RIG_ROOT = path.resolve(__dirname, '..');

export const KNOWN_HARNESSES = [
  {
    id: 'antigravity',
    label: 'Antigravity (IDE / 2.0 / agy CLI)',
    detectRel: '.gemini',
    configRel: '.gemini/config',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    detectRel: '.claude',
    configRel: '.claude',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    detectRel: '.codex',
    configRel: '.codex',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    detectRel: '.cursor',
    configRel: '.cursor',
  },
];

export function detectHarnesses(homeDir = homedir()) {
  return KNOWN_HARNESSES.map((h) => {
    const detectPath = path.join(homeDir, h.detectRel);
    const configPath = path.join(homeDir, h.configRel);
    return {
      ...h,
      detectPath,
      configPath,
      detected: existsSync(detectPath),
    };
  });
}

export function detectRepoHarness(targetDir) {
  if (!targetDir) return null;
  const dir = path.resolve(targetDir);
  if (!existsSync(dir)) return null;

  if (existsSync(path.join(dir, '.gemini'))) return 'antigravity';
  if (existsSync(path.join(dir, '.claude')) || existsSync(path.join(dir, '.claude-plugin'))) return 'claude';
  if (existsSync(path.join(dir, '.codex'))) return 'codex';
  if (existsSync(path.join(dir, '.cursor'))) return 'cursor';

  const localCfgPath = path.join(dir, '.rig.local.json');
  if (existsSync(localCfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(localCfgPath, 'utf8'));
      const activeHarnesses = Object.keys(cfg.activeProfiles || {});
      if (activeHarnesses.length === 1) return activeHarnesses[0];
    } catch {
      // ignore
    }
  }
  return null;
}

export const ROLES = ['architect', 'worker', 'verifier', 'utility'];

export function loadCatalog(rigRoot = RIG_ROOT) {
  const catalogPath = path.join(rigRoot, 'templates', 'models.json');
  if (!existsSync(catalogPath)) {
    return { harnesses: {}, models: {} };
  }
  try {
    return JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch {
    return { harnesses: {}, models: {} };
  }
}

export function configFilePath(rigRoot = RIG_ROOT) {
  const local = path.join(rigRoot, '.rig.local.json');
  if (existsSync(local)) return local;
  try {
    const res = spawnSync('git', ['-C', rigRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
    });
    if (res.status === 0 && res.stdout.trim()) {
      const commonDir = res.stdout.trim();
      const mainCheckout = path.dirname(commonDir);
      const mainCfg = path.join(mainCheckout, '.rig.local.json');
      if (existsSync(mainCfg)) return mainCfg;
    }
  } catch {
    // ignore
  }
  return local;
}

export function ensureRigConfig(rigRoot = RIG_ROOT) {
  const p = configFilePath(rigRoot);
  if (!existsSync(p)) {
    if (path.basename(rigRoot) === '.rig') {
      const template = path.join(rigRoot, 'templates', 'rig-config.default.json');
      return existsSync(template) ? template : p;
    }
    const template = path.join(rigRoot, 'templates', 'rig-config.default.json');
    if (existsSync(template)) {
      try {
        mkdirSync(path.dirname(p), { recursive: true });
        copyFileSync(template, p);
      } catch {
        return template;
      }
    }
  }
  return p;
}

export function loadRigConfig(rigRoot = RIG_ROOT) {
  const p = configFilePath(rigRoot);
  const templatePath = path.join(rigRoot, 'templates', 'rig-config.default.json');
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      // fall through to template
    }
  }
  if (existsSync(templatePath)) {
    try {
      return JSON.parse(readFileSync(templatePath, 'utf8'));
    } catch {
      return { activeProfiles: {}, profiles: {} };
    }
  }
  return { activeProfiles: {}, profiles: {} };
}

export function writeRigConfig(config, rigRoot = RIG_ROOT) {
  const p = configFilePath(rigRoot);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return config;
}

export function resolveSubagentModel(harness, model, explicitSubagentModel = null, { rigRoot = RIG_ROOT, userConfig = null } = {}) {
  if (explicitSubagentModel) return explicitSubagentModel;
  const catalog = loadCatalog(rigRoot);
  const userModels = userConfig?.models ?? {};
  const userHarnesses = userConfig?.harnesses ?? {};

  const mergedModels = { ...(catalog.models || {}), ...userModels };
  const mergedHarnesses = { ...(catalog.harnesses || {}), ...userHarnesses };

  const modelEntry = mergedModels[model];
  if (modelEntry?.subagentSelector?.[harness]) {
    return modelEntry.subagentSelector[harness];
  }

  const harnessEntry = mergedHarnesses[harness];
  if (harnessEntry?.defaultSubagentSelector !== undefined && harnessEntry.defaultSubagentSelector !== null) {
    return harnessEntry.defaultSubagentSelector;
  }
  return model;
}

export function resolveProfile(harness, { profileName = null, rigRoot = RIG_ROOT, userConfig = null } = {}) {
  const cfg = userConfig ?? loadRigConfig(rigRoot);
  const targetProfileName = profileName || cfg.activeProfiles?.[harness];
  if (!targetProfileName) {
    throw new Error(`No active profile configured for harness: ${harness}`);
  }
  const profile = cfg.profiles?.[targetProfileName];
  if (!profile) {
    throw new Error(`Profile not found: ${targetProfileName}`);
  }

  const resolvedRoles = {};
  for (const role of ROLES) {
    const r = profile.roles?.[role];
    if (!r) {
      throw new Error(`Profile ${targetProfileName} missing role definition for: ${role}`);
    }
    const subagentModel = resolveSubagentModel(harness, r.model, r.subagentModel, { rigRoot, userConfig: cfg });
    resolvedRoles[role] = {
      model: r.model,
      subagentModel,
      effort: r.effort,
    };
  }

  return {
    harness,
    profileName: targetProfileName,
    roles: resolvedRoles,
  };
}

export function hydrateText(templateText, resolvedProfile) {
  let text = templateText;
  text = text.replaceAll('{{RIG_PROFILE}}', resolvedProfile.profileName);
  text = text.replaceAll('{{RIG_HARNESS}}', resolvedProfile.harness);

  for (const role of ROLES) {
    const roleData = resolvedProfile.roles[role];
    if (roleData) {
      const upper = role.toUpperCase();
      text = text.replaceAll(`{{MODEL_${upper}}}`, roleData.model);
      text = text.replaceAll(`{{SUBAGENT_MODEL_${upper}}}`, roleData.subagentModel);
      text = text.replaceAll(`{{EFFORT_${upper}}}`, roleData.effort);
    }
  }

  const leftover = text.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (leftover) {
    throw new Error(`Unresolved template placeholder(s) in hydrated content: ${[...new Set(leftover)].join(', ')}`);
  }
  return text;
}

export function rewriteDocLinks(
  text,
  { harness = null, isGlobal = false, destPath = null, isDotHarness = false } = {},
) {
  let result = text;
  if (isGlobal) {
    result = result.replaceAll('../../docs/', 'docs/');
  }
  if (isDotHarness) {
    result = result.replaceAll('../../docs/', '../../../docs/');
    result = result.replaceAll('`scripts/check-doc-links.mjs`', '`.rig/scripts/check-doc-links.mjs`');
    result = result.replaceAll('`scripts/reflow-docs.mjs`', '`.rig/scripts/reflow-docs.mjs`');
    result = result.replaceAll('`hooks/guard-main-checkout-edits.mjs`', '`.rig/hooks/guard-main-checkout-edits.mjs`');
    result = result.replaceAll('`hooks/guard-symlinked-node-modules.mjs`', '`.rig/hooks/guard-symlinked-node-modules.mjs`');
    result = result.replaceAll('`hooks/guard-remote-mutation.mjs`', '`.rig/hooks/guard-remote-mutation.mjs`');
    result = result.replaceAll('`hooks/lib/hook-io.mjs`', '`.rig/hooks/lib/hook-io.mjs`');
  }
  if (harness === 'codex') {
    const isDirectAgentsMd = destPath && path.basename(destPath) === 'AGENTS.md' && !/[\\/]rules[\\/]/.test(destPath);
    if (isDirectAgentsMd) {
      result = result.replaceAll('../skills/', 'skills/');
      result = result.replaceAll('../rules/', 'rules/');
      result = result.replaceAll('../agents/', 'agents/');
    }
    result = result.replaceAll('../../rules/AGENTS.md', '../../AGENTS.md');
  }
  return result;
}

export function getHydratedFileContent(
  srcPath,
  destPath,
  resolvedProfile,
  { isGlobal = false, harness = null, isDotHarness = false } = {},
) {
  const template = readFileSync(srcPath, 'utf8');
  let hydrated = hydrateText(template, resolvedProfile);
  hydrated = rewriteDocLinks(hydrated, {
    harness: harness || resolvedProfile?.harness,
    isGlobal,
    destPath,
    isDotHarness,
  });
  return hydrated;
}

export function writeHydratedFile(
  srcPath,
  destPath,
  resolvedProfile,
  { executable = false, isGlobal = false, harness = null, isDotHarness = false } = {},
) {
  const hydrated = getHydratedFileContent(srcPath, destPath, resolvedProfile, { isGlobal, harness, isDotHarness });
  mkdirSync(path.dirname(destPath), { recursive: true });
  if (isSymlink(destPath)) rmSync(destPath, { recursive: true, force: true });
  writeFileSync(destPath, hydrated, 'utf8');
  if (executable) chmodSync(destPath, 0o755);
}

export function buildManagedAgentsBlock(resolvedProfile, { rigRoot = RIG_ROOT, isSelfContained = false } = {}) {
  const candidates = [
    path.join(rigRoot, 'rules/AGENTS.md'),
    path.join(rigRoot, '.rig/rules/AGENTS.md'),
    path.join(rigRoot, '../rules/AGENTS.md'),
    path.join(homedir(), '.gemini/config/plugins/agent-rig/rules/AGENTS.md'),
    path.join(homedir(), '.claude/plugins/agent-rig/rules/AGENTS.md'),
  ];
  const rulesAgentsPath = candidates.find((c) => existsSync(c)) || path.join(rigRoot, 'rules/AGENTS.md');
  const template = readFileSync(rulesAgentsPath, 'utf8');
  let hydrated = hydrateText(template, resolvedProfile);
  hydrated = hydrated.replaceAll('../skills/', 'skills/');
  hydrated = hydrated.replaceAll('../agents/', 'agents/');
  hydrated = hydrated.replaceAll('../rules/', 'rules/');
  hydrated = hydrated.replaceAll('../../docs/', 'docs/');

  return `${MANAGED_AGENTS_START}\n${MANAGED_AGENTS_HEADER}\n${hydrated.trim()}\n${MANAGED_AGENTS_END}`;
}


export function copyOrHydrateDir(
  srcDir,
  destDir,
  resolvedProfile,
  { hydrated = [], isGlobal = false, harness = null, isDotHarness = false } = {},
) {
  if (isSymlink(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcEntry = path.join(srcDir, entry);
    const destEntry = path.join(destDir, entry);
    const stat = lstatSync(srcEntry);
    if (stat.isDirectory()) {
      copyOrHydrateDir(srcEntry, destEntry, resolvedProfile, { hydrated, isGlobal, harness, isDotHarness });
    } else if (stat.isFile()) {
      if (srcEntry.endsWith('.md')) {
        writeHydratedFile(srcEntry, destEntry, resolvedProfile, { isGlobal, harness, isDotHarness });
        hydrated.push(destEntry);
      } else {
        copyFileSafe(srcEntry, destEntry, { force: true, copied: hydrated });
      }
    }
  }
}

function stateFilePath(homeDir = homedir()) {
  return path.join(homeDir, '.config', 'agent-rig', 'state.json');
}

export function readRigState(homeDir = homedir()) {
  const p = stateFilePath(homeDir);
  if (!existsSync(p)) return { installedHarnesses: [], initializedRepos: [], installedSkills: [], nodeBin: null };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return {
      installedHarnesses: Array.isArray(raw.installedHarnesses) ? raw.installedHarnesses : [],
      initializedRepos: Array.isArray(raw.initializedRepos) ? raw.initializedRepos : [],
      installedSkills: Array.isArray(raw.installedSkills) ? raw.installedSkills : [],
      nodeBin: typeof raw.nodeBin === 'string' ? raw.nodeBin : null,
    };
  } catch {
    return { installedHarnesses: [], initializedRepos: [], installedSkills: [], nodeBin: null };
  }
}

export function writeRigState(homeDir, patch, { replace = false } = {}) {
  const current = readRigState(homeDir);
  const shouldReplace = (field) => replace === true || (typeof replace === 'object' && replace !== null && Boolean(replace[field]));
  const next = {
    installedHarnesses: Array.isArray(patch.installedHarnesses)
      ? (shouldReplace('installedHarnesses') ? patch.installedHarnesses : [...new Set([...current.installedHarnesses, ...patch.installedHarnesses])])
      : current.installedHarnesses,
    initializedRepos: Array.isArray(patch.initializedRepos)
      ? (shouldReplace('initializedRepos') ? patch.initializedRepos : [...new Set([...current.initializedRepos, ...patch.initializedRepos])])
      : current.initializedRepos,
    installedSkills: Array.isArray(patch.installedSkills)
      ? (shouldReplace('installedSkills') ? patch.installedSkills : [...new Set([...current.installedSkills, ...patch.installedSkills])])
      : current.installedSkills,
    nodeBin: patch.nodeBin !== undefined ? patch.nodeBin : current.nodeBin,
  };
  const p = stateFilePath(homeDir);
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch (err) {
    if (err && err.code === 'EROFS') return next;
    throw err;
  }
  return next;
}

function copyFileSafe(src, dest, { force = false, copied = [], skipped = [], executable = false } = {}) {
  if ((existsSync(dest) || isSymlink(dest)) && !force) {
    skipped.push(dest);
    return false;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  if (isSymlink(dest)) rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, force: true });
  if (executable) chmodSync(dest, 0o755);
  copied.push(dest);
  return true;
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function pruneDanglingRigSymlinks(dir, pruned = [], rigRoot = RIG_ROOT) {
  if (!existsSync(dir)) return pruned;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!isSymlink(full)) continue;
    const target = path.resolve(dir, readlinkSync(full));
    if (target.startsWith(rigRoot) && !existsSync(target)) {
      rmSync(full, { recursive: true, force: true });
      pruned.push(full);
    }
  }
  return pruned;
}

function pruneRigSymlinks(dir, { rigRoot = RIG_ROOT, pruned = [] } = {}) {
  if (!existsSync(dir)) return pruned;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!isSymlink(full)) continue;
    try {
      const rawTarget = readlinkSync(full);
      const target = path.resolve(dir, rawTarget);
      if (target.startsWith(rigRoot)) {
        rmSync(full, { recursive: true, force: true });
        pruned.push(full);
      }
    } catch {
      // ignore broken links
    }
  }
  return pruned;
}

function pruneMissingRigEntries(installedDir, validNames, { pruned = [] } = {}) {
  if (!existsSync(installedDir)) return pruned;
  for (const entry of readdirSync(installedDir)) {
    if (!validNames.includes(entry)) {
      const full = path.join(installedDir, entry);
      rmSync(full, { recursive: true, force: true });
      pruned.push(full);
    }
  }
  return pruned;
}

export function linkSafe(src, dest, { force = false, linked = [], skipped = [] } = {}) {
  if (isSymlink(dest)) {
    try {
      const rawTarget = readlinkSync(dest);
      const existingTarget = path.resolve(path.dirname(dest), rawTarget);
      if (existingTarget === path.resolve(src)) {
        skipped.push(dest);
        return false;
      }
    } catch {
      // unreadable or broken symlink; proceed
    }
  }

  if (existsSync(dest) || isSymlink(dest)) {
    if (!force) {
      skipped.push(dest);
      return false;
    }
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  symlinkSync(src, dest);
  linked.push(dest);
  return true;
}

export const DEFAULT_SYSTEM_PATH =
  process.platform === 'win32'
    ? (process.env.PATH || '')
    : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin';

export function resolveNodeBinary({
  execPath = process.execPath,
  systemPath = DEFAULT_SYSTEM_PATH,
} = {}) {
  const checkCmd = process.platform === 'win32' ? 'where node' : 'command -v node';
  const res = spawnSync(checkCmd, {
    shell: true,
    env: { ...process.env, PATH: systemPath },
    stdio: 'ignore',
  });
  return res.status === 0 ? 'node' : execPath;
}

export function buildNodeFallbackShell(nodeBin, { isHook = false, singleLine = false } = {}) {
  const repointMsg = isHook
    ? "agent-rig: Node runtime not found at '$NODE'. Run 'rig update' in your terminal to re-point hooks."
    : "agent-rig: Node runtime not found at '$NODE'. Run 'rig update' in your terminal to re-point.";

  if (singleLine) {
    return `NODE="${nodeBin}"; if [ ! -x "$NODE" ] && ! command -v "$NODE" >/dev/null 2>&1; then _FOUND=""; if command -v node >/dev/null 2>&1; then _FOUND="$(command -v node)"; elif [ -x "\${FNM_DIR:-$HOME/.local/share/fnm}/current/bin/node" ]; then _FOUND="\${FNM_DIR:-$HOME/.local/share/fnm}/current/bin/node"; elif [ -x "\${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin/node" ]; then _FOUND="\${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin/node"; elif [ -x "$HOME/.fnm/current/bin/node" ]; then _FOUND="$HOME/.fnm/current/bin/node"; elif [ -x "$HOME/.fnm/aliases/default/bin/node" ]; then _FOUND="$HOME/.fnm/aliases/default/bin/node"; elif [ -n "$NVM_BIN" ] && [ -x "$NVM_BIN/node" ]; then _FOUND="$NVM_BIN/node"; elif [ -x "\${NVM_DIR:-$HOME/.nvm}/current/bin/node" ]; then _FOUND="\${NVM_DIR:-$HOME/.nvm}/current/bin/node"; elif [ -s "\${NVM_DIR:-$HOME/.nvm}/alias/default" ] && [ -x "\${NVM_DIR:-$HOME/.nvm}/versions/node/$(cat "\${NVM_DIR:-$HOME/.nvm}/alias/default" 2>/dev/null)/bin/node" ]; then _FOUND="\${NVM_DIR:-$HOME/.nvm}/versions/node/$(cat "\${NVM_DIR:-$HOME/.nvm}/alias/default" 2>/dev/null)/bin/node"; elif [ -x "\${ASDF_DATA_DIR:-$HOME/.asdf}/shims/node" ]; then _FOUND="\${ASDF_DATA_DIR:-$HOME/.asdf}/shims/node"; elif [ -x "\${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims/node" ]; then _FOUND="\${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims/node"; elif [ -x "\${VOLTA_HOME:-$HOME/.volta}/bin/node" ]; then _FOUND="\${VOLTA_HOME:-$HOME/.volta}/bin/node"; elif [ -x "\${NODENV_ROOT:-$HOME/.nodenv}/shims/node" ]; then _FOUND="\${NODENV_ROOT:-$HOME/.nodenv}/shims/node"; fi; if [ -z "$_FOUND" ]; then for _n in "\${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node "\${FNM_DIR:-$HOME/.local/share/fnm}"/installed-versions/*/installation/bin/node; do if [ -x "$_n" ]; then _FOUND="$_n"; fi; done; fi; if [ -n "$_FOUND" ] && [ -x "$_FOUND" ]; then NODE="$_FOUND"; else echo "${repointMsg}" >&2; exit 1; fi; fi;`;
  }

  return `NODE="${nodeBin}"
if [ ! -x "$NODE" ] && ! command -v "$NODE" >/dev/null 2>&1; then
  _FOUND=""
  if command -v node >/dev/null 2>&1; then
    _FOUND="$(command -v node)"
  elif [ -x "\${FNM_DIR:-$HOME/.local/share/fnm}/current/bin/node" ]; then
    _FOUND="\${FNM_DIR:-$HOME/.local/share/fnm}/current/bin/node"
  elif [ -x "\${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin/node" ]; then
    _FOUND="\${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin/node"
  elif [ -x "$HOME/.fnm/current/bin/node" ]; then
    _FOUND="$HOME/.fnm/current/bin/node"
  elif [ -x "$HOME/.fnm/aliases/default/bin/node" ]; then
    _FOUND="$HOME/.fnm/aliases/default/bin/node"
  elif [ -n "$NVM_BIN" ] && [ -x "$NVM_BIN/node" ]; then
    _FOUND="$NVM_BIN/node"
  elif [ -x "\${NVM_DIR:-$HOME/.nvm}/current/bin/node" ]; then
    _FOUND="\${NVM_DIR:-$HOME/.nvm}/current/bin/node"
  elif [ -s "\${NVM_DIR:-$HOME/.nvm}/alias/default" ] && [ -x "\${NVM_DIR:-$HOME/.nvm}/versions/node/$(cat "\${NVM_DIR:-$HOME/.nvm}/alias/default" 2>/dev/null)/bin/node" ]; then
    _FOUND="\${NVM_DIR:-$HOME/.nvm}/versions/node/$(cat "\${NVM_DIR:-$HOME/.nvm}/alias/default" 2>/dev/null)/bin/node"
  elif [ -x "\${ASDF_DATA_DIR:-$HOME/.asdf}/shims/node" ]; then
    _FOUND="\${ASDF_DATA_DIR:-$HOME/.asdf}/shims/node"
  elif [ -x "\${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims/node" ]; then
    _FOUND="\${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims/node"
  elif [ -x "\${VOLTA_HOME:-$HOME/.volta}/bin/node" ]; then
    _FOUND="\${VOLTA_HOME:-$HOME/.volta}/bin/node"
  elif [ -x "\${NODENV_ROOT:-$HOME/.nodenv}/shims/node" ]; then
    _FOUND="\${NODENV_ROOT:-$HOME/.nodenv}/shims/node"
  fi
  if [ -z "$_FOUND" ]; then
    for _n in "\${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node "\${FNM_DIR:-$HOME/.local/share/fnm}"/installed-versions/*/installation/bin/node; do
      if [ -x "$_n" ]; then _FOUND="$_n"; fi
    done
  fi
  if [ -n "$_FOUND" ] && [ -x "$_FOUND" ]; then
    NODE="$_FOUND"
  else
    echo "${repointMsg}" >&2
    exit 1
  fi
fi`;
}

export function buildHookCommand(scriptPath, args = '', { nodeBin = resolveNodeBinary() } = {}) {
  const argsSuffix = args ? ` ${args}` : '';
  const quotedScript = scriptPath.startsWith('"') && scriptPath.endsWith('"') ? scriptPath : `"${scriptPath}"`;
  const fallback = buildNodeFallbackShell(nodeBin, { isHook: true, singleLine: true });
  return `${fallback} exec "$NODE" ${quotedScript}${argsSuffix}`;
}

export function buildRigWrapperScript(rigScriptPath, { nodeBin = resolveNodeBinary() } = {}) {
  const quotedScript =
    rigScriptPath.startsWith('"') && rigScriptPath.endsWith('"') ? rigScriptPath : `"${rigScriptPath}"`;
  const fallback = buildNodeFallbackShell(nodeBin, { isHook: false, singleLine: false });
  return `#!/bin/sh
${fallback}
exec "$NODE" ${quotedScript} "$@"
`;
}

export function hydrateAntigravityHooksJson(rawJsonOrObj, { nodeBin = resolveNodeBinary() } = {}) {
  const obj = typeof rawJsonOrObj === 'string' ? JSON.parse(rawJsonOrObj) : structuredClone(rawJsonOrObj);
  for (const [key, section] of Object.entries(obj)) {
    if (!section || typeof section !== 'object') continue;
    for (const [event, ruleList] of Object.entries(section)) {
      if (!Array.isArray(ruleList)) continue;
      for (const rule of ruleList) {
        if (!rule || !Array.isArray(rule.hooks)) continue;
        for (const hook of rule.hooks) {
          if (hook && hook.type === 'command' && typeof hook.command === 'string') {
            const rawCmd = hook.command;
            let script = null;
            let args = '';
            if (rawCmd.startsWith('node ')) {
              const parts = rawCmd.slice(5).trim();
              const firstSpace = parts.indexOf(' ');
              if (firstSpace === -1) {
                script = parts;
              } else {
                script = parts.slice(0, firstSpace);
                args = parts.slice(firstSpace + 1);
              }
            } else {
              const match = rawCmd.match(/exec\s+"\$NODE"\s+"?([^"\s]+)"?(?:\s+(.*))?$/);
              if (match) {
                script = match[1];
                args = match[2] || '';
              }
            }
            if (script) {
              hook.command = buildHookCommand(script, args, { nodeBin });
            }
          }
        }
      }
    }
  }
  return obj;
}

export function mergeClaudeSettings(existing, incoming) {
  const result = structuredClone(existing && typeof existing === 'object' ? existing : {});
  if (!incoming?.hooks || typeof incoming.hooks !== 'object') return result;

  if (!result.hooks || typeof result.hooks !== 'object') {
    result.hooks = {};
  }

  for (const [eventName, incomingGroups] of Object.entries(incoming.hooks)) {
    if (!Array.isArray(incomingGroups)) continue;
    if (!Array.isArray(result.hooks[eventName])) {
      result.hooks[eventName] = [];
    }
    const targetGroups = result.hooks[eventName];

    for (const inGroup of incomingGroups) {
      const matcher = inGroup.matcher ?? '';
      let existingGroup = targetGroups.find((g) => (g.matcher ?? '') === matcher);
      if (!existingGroup) {
        existingGroup = { ...(inGroup.matcher !== undefined ? { matcher: inGroup.matcher } : {}), hooks: [] };
        targetGroups.push(existingGroup);
      }
      if (!Array.isArray(existingGroup.hooks)) existingGroup.hooks = [];
      for (const inHook of inGroup.hooks ?? []) {
        const rigScriptMatch = inHook.command.match(/guard-(?:remote-mutation|symlinked-node-modules|main-checkout-edits)\.mjs/);
        const existingIdx = rigScriptMatch
          ? existingGroup.hooks.findIndex((h) => h.type === inHook.type && h.command.includes(rigScriptMatch[0]))
          : existingGroup.hooks.findIndex((h) => h.type === inHook.type && h.command === inHook.command);

        if (existingIdx !== -1) {
          existingGroup.hooks[existingIdx] = structuredClone(inHook);
        } else {
          existingGroup.hooks.push(structuredClone(inHook));
        }
      }
    }
  }
  return result;
}

export function mergeAntigravityPluginsJson(existing, pluginContainerDir) {
  const base = existing && typeof existing === 'object' ? structuredClone(existing) : {};
  if (!Array.isArray(base.entries)) {
    base.entries = [];
  }
  if (!base.entries.some((e) => e && e.path === pluginContainerDir)) {
    base.entries.push({ path: pluginContainerDir });
  }
  return base;
}

function installForAntigravity(homeDir, { force = false, hydrated = [], linked = [], skipped = [], updated = [], pruned = [], rigRoot = RIG_ROOT, nodeBin = resolveNodeBinary() } = {}) {
  const binDir = path.join(homeDir, '.gemini', 'antigravity', 'bin');
  mkdirSync(binDir, { recursive: true });
  pruneDanglingRigSymlinks(binDir, pruned, rigRoot);
  const rigBinPath = path.join(binDir, 'rig');
  const rigWrapperContent = buildRigWrapperScript(path.join(rigRoot, 'bin/rig.mjs'), { nodeBin });
  try {
    const existing = existsSync(rigBinPath) && !isSymlink(rigBinPath) ? readFileSync(rigBinPath, 'utf8') : null;
    if (existing !== rigWrapperContent) {
      if (existsSync(rigBinPath) || isSymlink(rigBinPath)) {
        rmSync(rigBinPath, { force: true, recursive: true });
      }
      writeFileSync(rigBinPath, rigWrapperContent, { encoding: 'utf8', mode: 0o755 });
      chmodSync(rigBinPath, 0o755);
      updated.push(rigBinPath);
    } else {
      skipped.push(rigBinPath);
    }
  } catch {
    rmSync(rigBinPath, { force: true, recursive: true });
    writeFileSync(rigBinPath, rigWrapperContent, { encoding: 'utf8', mode: 0o755 });
    chmodSync(rigBinPath, 0o755);
    updated.push(rigBinPath);
  }

  if (nodeBin && nodeBin !== 'node' && path.isAbsolute(nodeBin) && existsSync(nodeBin)) {
    const nodeDest = path.join(binDir, 'node');
    linkSafe(nodeBin, nodeDest, { force, linked, skipped });

    const adjacentNpm = path.join(path.dirname(nodeBin), 'npm');
    if (existsSync(adjacentNpm)) {
      const npmDest = path.join(binDir, 'npm');
      linkSafe(adjacentNpm, npmDest, { force, linked, skipped });
    }
  }

  const configDir = path.join(homeDir, '.gemini', 'config');
  const pluginsDir = path.join(configDir, 'plugins');
  const pluginDir = path.join(pluginsDir, 'agent-rig');
  mkdirSync(pluginsDir, { recursive: true });

  if (isSymlink(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true });
  }
  mkdirSync(pluginDir, { recursive: true });

  const resolvedProfile = resolveProfile('antigravity', { rigRoot });

  copyFileSafe(path.join(rigRoot, 'plugin.json'), path.join(pluginDir, 'plugin.json'), { force: true, copied: updated });

  const hooksSrcPath = path.join(rigRoot, 'hooks.json');
  const hooksDestPath = path.join(pluginDir, 'hooks.json');
  if (existsSync(hooksSrcPath)) {
    const rawTemplate = readFileSync(hooksSrcPath, 'utf8');
    const hydratedHooks = hydrateAntigravityHooksJson(rawTemplate, { nodeBin });
    writeFileSync(hooksDestPath, JSON.stringify(hydratedHooks, null, 2) + '\n', 'utf8');
    updated.push(hooksDestPath);
  }

  linkSafe(path.join(rigRoot, 'hooks'), path.join(pluginDir, 'hooks'), { force: true, linked, skipped });

  const rulesSrcDir = path.join(rigRoot, 'rules');
  const rulesDestDir = path.join(pluginDir, 'rules');
  mkdirSync(rulesDestDir, { recursive: true });
  for (const rule of readdirSync(rulesSrcDir)) {
    if (rule === 'AGENTS.md') continue;
    const src = path.join(rulesSrcDir, rule);
    const dest = path.join(rulesDestDir, rule);
    if (rule.endsWith('.md')) {
      writeHydratedFile(src, dest, resolvedProfile, { isGlobal: true, harness: 'antigravity' });
      hydrated.push(dest);
    } else {
      copyFileSafe(src, dest, { force: true, copied: hydrated });
    }
  }
  const legacyPluginAgentsMd = path.join(rulesDestDir, 'AGENTS.md');
  if (existsSync(legacyPluginAgentsMd)) {
    rmSync(legacyPluginAgentsMd, { force: true });
    pruned.push(legacyPluginAgentsMd);
  }

  const skillsSrcDir = path.join(rigRoot, 'skills');
  const skillsDestDir = path.join(pluginDir, 'skills');
  mkdirSync(skillsDestDir, { recursive: true });
  const rigSkills = readdirSync(skillsSrcDir);
  for (const skill of rigSkills) {
    copyOrHydrateDir(path.join(skillsSrcDir, skill), path.join(skillsDestDir, skill), resolvedProfile, { hydrated, isGlobal: true, harness: 'antigravity' });
  }
  pruneMissingRigEntries(skillsDestDir, rigSkills, { pruned });

  const agentsSrcDir = path.join(rigRoot, 'agents');
  if (existsSync(agentsSrcDir)) {
    const agentsDestDir = path.join(pluginDir, 'agents');
    mkdirSync(agentsDestDir, { recursive: true });
    for (const agent of readdirSync(agentsSrcDir)) {
      const src = path.join(agentsSrcDir, agent);
      const dest = path.join(agentsDestDir, agent);
      if (agent.endsWith('.md')) {
        writeHydratedFile(src, dest, resolvedProfile, { isGlobal: true, harness: 'antigravity' });
        hydrated.push(dest);
      } else {
        copyFileSafe(src, dest, { force: true, copied: hydrated });
      }
    }
  }

  const pluginsJsonPath = path.join(configDir, 'plugins.json');
  let current = {};
  if (existsSync(pluginsJsonPath)) {
    try {
      current = JSON.parse(readFileSync(pluginsJsonPath, 'utf8'));
    } catch {
      current = {};
    }
  }
  const merged = mergeAntigravityPluginsJson(current, pluginsDir);
  writeFileSync(pluginsJsonPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  updated.push(pluginsJsonPath);
}

function installForClaude(homeDir, { force = false, hydrated = [], linked = [], skipped = [], updated = [], pruned = [], rigRoot = RIG_ROOT, obsoleteSkills = [], nodeBin = resolveNodeBinary() } = {}) {
  const claudeDir = path.join(homeDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const resolvedProfile = resolveProfile('claude', { rigRoot });

  for (const sub of ['skills', 'agents', 'rules']) {
    pruneRigSymlinks(path.join(claudeDir, sub), { rigRoot, pruned });
  }
  pruneDanglingRigSymlinks(path.join(claudeDir, 'hooks'), pruned);

  for (const oldSkill of obsoleteSkills) {
    const p = path.join(claudeDir, 'skills', oldSkill);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      pruned.push(p);
    }
  }

  const skillsDir = path.join(rigRoot, 'skills');
  for (const skill of readdirSync(skillsDir)) {
    copyOrHydrateDir(path.join(skillsDir, skill), path.join(claudeDir, 'skills', skill), resolvedProfile, { hydrated, isGlobal: true, harness: 'claude' });
  }

  const agentsDir = path.join(rigRoot, 'agents');
  if (existsSync(agentsDir)) {
    for (const agent of readdirSync(agentsDir)) {
      const src = path.join(agentsDir, agent);
      const dest = path.join(claudeDir, 'agents', agent);
      if (agent.endsWith('.md')) {
        writeHydratedFile(src, dest, resolvedProfile, { isGlobal: true, harness: 'claude' });
        hydrated.push(dest);
      } else {
        copyFileSafe(src, dest, { force: true, copied: hydrated });
      }
    }
  }

  const rulesDir = path.join(rigRoot, 'rules');
  const claudeRulesDir = path.join(claudeDir, 'rules');
  mkdirSync(claudeRulesDir, { recursive: true });
  if (existsSync(rulesDir)) {
    for (const rule of readdirSync(rulesDir)) {
      if (rule === 'AGENTS.md') continue;
      const src = path.join(rulesDir, rule);
      const dest = path.join(claudeRulesDir, rule);
      if (rule.endsWith('.md')) {
        writeHydratedFile(src, dest, resolvedProfile, { isGlobal: true, harness: 'claude' });
        hydrated.push(dest);
      } else {
        copyFileSafe(src, dest, { force: true, copied: hydrated });
      }
    }
  }

  const legacyClaudeAgentsMd = path.join(claudeDir, 'rules', 'AGENTS.md');
  if (existsSync(legacyClaudeAgentsMd)) {
    try {
      const text = readFileSync(legacyClaudeAgentsMd, 'utf8');
      if (text.includes('Universal Agentic Engineering Rules (`agent-rig`)') || text.includes(MANAGED_AGENTS_START)) {
        rmSync(legacyClaudeAgentsMd, { force: true });
        pruned.push(legacyClaudeAgentsMd);
      } else {
        console.warn(`Notice: Found custom ${legacyClaudeAgentsMd}; preserving it.`);
      }
    } catch {
      // ignore
    }
  }

  for (const hookEntry of ['guard-remote-mutation.mjs', 'guard-main-checkout-edits.mjs', 'guard-symlinked-node-modules.mjs', 'lib']) {
    linkSafe(path.join(rigRoot, 'hooks', hookEntry), path.join(claudeDir, 'hooks', hookEntry), { force: true, linked, skipped });
  }

  const settingsPath = path.join(claudeDir, 'settings.json');
  let existing = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      existing = {};
    }
  }
  const globalHooks = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: buildHookCommand(path.join(claudeDir, 'hooks/guard-remote-mutation.mjs'), '--harness=claude', { nodeBin }) },
            { type: 'command', command: buildHookCommand(path.join(claudeDir, 'hooks/guard-symlinked-node-modules.mjs'), '--harness=claude', { nodeBin }) },
          ],
        },
        {
          matcher: 'Edit|Write',
          hooks: [
            { type: 'command', command: buildHookCommand(path.join(claudeDir, 'hooks/guard-main-checkout-edits.mjs'), '--harness=claude', { nodeBin }) },
          ],
        },
      ],
    },
  };
  const merged = mergeClaudeSettings(existing, globalHooks);
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  updated.push(settingsPath);
}

function installForCodex(homeDir, { force = false, hydrated = [], skipped = [], pruned = [], rigRoot = RIG_ROOT, obsoleteSkills = [] }) {
  const codexDir = path.join(homeDir, '.codex');
  mkdirSync(codexDir, { recursive: true });
  pruneRigSymlinks(path.join(codexDir, 'skills'), { rigRoot, pruned });
  pruneRigSymlinks(codexDir, { rigRoot, pruned });

  for (const oldSkill of obsoleteSkills) {
    const p = path.join(codexDir, 'skills', oldSkill);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      pruned.push(p);
    }
  }

  const resolvedProfile = resolveProfile('codex', { rigRoot });
  const skillsDir = path.join(rigRoot, 'skills');
  for (const skill of readdirSync(skillsDir)) {
    copyOrHydrateDir(path.join(skillsDir, skill), path.join(codexDir, 'skills', skill), resolvedProfile, { hydrated, isGlobal: true, harness: 'codex' });
  }
  const codexAgentsMd = path.join(codexDir, 'AGENTS.md');
  if (existsSync(codexAgentsMd)) {
    try {
      const text = readFileSync(codexAgentsMd, 'utf8');
      if (text.includes('Universal Agentic Engineering Rules (`agent-rig`)') || text.includes(MANAGED_AGENTS_START)) {
        rmSync(codexAgentsMd, { force: true });
        pruned.push(codexAgentsMd);
      } else {
        console.warn(`Notice: Found custom ${codexAgentsMd}; preserving it.`);
      }
    } catch {
      // ignore
    }
  }
}

function installForCursor(homeDir, { force = false, hydrated = [], skipped = [], pruned = [], rigRoot = RIG_ROOT, obsoleteSkills = [] }) {
  const cursorDir = path.join(homeDir, '.cursor');
  mkdirSync(cursorDir, { recursive: true });
  pruneRigSymlinks(path.join(cursorDir, 'skills'), { rigRoot, pruned });
  pruneRigSymlinks(path.join(cursorDir, 'rules'), { rigRoot, pruned });

  for (const oldSkill of obsoleteSkills) {
    const p = path.join(cursorDir, 'skills', oldSkill);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      pruned.push(p);
    }
  }

  const resolvedProfile = resolveProfile('cursor', { rigRoot });
  const skillsDir = path.join(rigRoot, 'skills');
  for (const skill of readdirSync(skillsDir)) {
    copyOrHydrateDir(path.join(skillsDir, skill), path.join(cursorDir, 'skills', skill), resolvedProfile, { hydrated, isGlobal: true, harness: 'cursor' });
  }
  const cursorAgentsMd = path.join(cursorDir, 'rules', 'AGENTS.md');
  if (existsSync(cursorAgentsMd)) {
    try {
      const text = readFileSync(cursorAgentsMd, 'utf8');
      if (text.includes('Universal Agentic Engineering Rules (`agent-rig`)') || text.includes(MANAGED_AGENTS_START)) {
        rmSync(cursorAgentsMd, { force: true });
        pruned.push(cursorAgentsMd);
      } else {
        console.warn(`Notice: Found custom ${cursorAgentsMd}; preserving it.`);
      }
    } catch {
      // ignore
    }
  }
}

export function installRig({
  homeDir = homedir(),
  harnesses = null,
  detectedOnly = false,
  force = false,
  rigRoot = RIG_ROOT,
  nodeBin = null,
} = {}) {
  ensureRigConfig(rigRoot);
  const discovered = detectHarnesses(homeDir);
  let selectedIds;
  if (Array.isArray(harnesses) && harnesses.length > 0) {
    selectedIds = harnesses.map((h) => h.trim().toLowerCase()).filter(Boolean);
  } else if (detectedOnly) {
    selectedIds = discovered.filter((d) => d.detected).map((d) => d.id);
  } else {
    selectedIds = discovered.filter((d) => d.detected).map((d) => d.id);
  }

  const state = readRigState(homeDir);
  const resolvedNodeBin = nodeBin || state.nodeBin || resolveNodeBinary();
  const currentSkills = existsSync(path.join(rigRoot, 'skills')) ? readdirSync(path.join(rigRoot, 'skills')) : [];
  const obsoleteSkills = (state.installedSkills || []).filter((s) => !currentSkills.includes(s));

  const hydrated = [];
  const linked = [];
  const skipped = [];
  const updated = [];
  const pruned = [];

  const localBinDir = path.join(homeDir, '.local', 'bin');
  mkdirSync(localBinDir, { recursive: true });
  pruneDanglingRigSymlinks(localBinDir, pruned, rigRoot);
  const localBinRig = path.join(localBinDir, 'rig');
  const rigWrapperContent = buildRigWrapperScript(path.join(rigRoot, 'bin/rig.mjs'), { nodeBin: resolvedNodeBin });
  try {
    const existing = existsSync(localBinRig) && !isSymlink(localBinRig) ? readFileSync(localBinRig, 'utf8') : null;
    if (existing !== rigWrapperContent) {
      if (existsSync(localBinRig) || isSymlink(localBinRig)) {
        rmSync(localBinRig, { force: true, recursive: true });
      }
      writeFileSync(localBinRig, rigWrapperContent, { encoding: 'utf8', mode: 0o755 });
      chmodSync(localBinRig, 0o755);
      updated.push(localBinRig);
    } else {
      skipped.push(localBinRig);
    }
  } catch {
    rmSync(localBinRig, { force: true, recursive: true });
    writeFileSync(localBinRig, rigWrapperContent, { encoding: 'utf8', mode: 0o755 });
    chmodSync(localBinRig, 0o755);
    updated.push(localBinRig);
  }

  for (const id of selectedIds) {
    if (id === 'antigravity') installForAntigravity(homeDir, { force, hydrated, linked, skipped, updated, pruned, rigRoot, nodeBin: resolvedNodeBin });
    else if (id === 'claude') installForClaude(homeDir, { force, hydrated, linked, skipped, updated, pruned, rigRoot, obsoleteSkills, nodeBin: resolvedNodeBin });
    else if (id === 'codex') installForCodex(homeDir, { force, hydrated, skipped, pruned, rigRoot, obsoleteSkills });
    else if (id === 'cursor') installForCursor(homeDir, { force, hydrated, skipped, pruned, rigRoot, obsoleteSkills });
    else throw new Error(`Unknown harness id: ${id}`);
  }

  writeRigState(homeDir, { installedHarnesses: selectedIds, installedSkills: currentSkills, nodeBin: resolvedNodeBin });

  if (existsSync(path.join(rigRoot, '.git'))) {
    attachMainCheckout(rigRoot);
  }

  return {
    discovered,
    installedHarnesses: selectedIds,
    localBin: localBinRig,
    hydrated,
    linked,
    skipped,
    updated,
    pruned,
  };
}

export const installGlobal = installRig;

export const VENDORED_RIG_FILES = [
  { src: 'bin/rig.mjs', dest: '.rig/bin/rig.mjs' },
  { src: 'rules/AGENTS.md', dest: '.rig/rules/AGENTS.md' },
  { src: 'templates/models.json', dest: '.rig/templates/models.json' },
  { src: 'templates/rig-config.default.json', dest: '.rig/templates/rig-config.default.json' },
  { src: 'scripts/check-doc-links.mjs', dest: '.rig/scripts/check-doc-links.mjs' },
  { src: 'scripts/reflow-docs.mjs', dest: '.rig/scripts/reflow-docs.mjs' },
  { src: 'hooks/lib/hook-io.mjs', dest: '.rig/hooks/lib/hook-io.mjs' },
  { src: 'hooks/lib/hook-io.mjs', dest: '.rig/hooks/hook-io.mjs' },
  { src: 'hooks/guard-remote-mutation.mjs', dest: '.rig/hooks/guard-remote-mutation.mjs' },
  { src: 'hooks/guard-main-checkout-edits.mjs', dest: '.rig/hooks/guard-main-checkout-edits.mjs' },
  { src: 'hooks/guard-symlinked-node-modules.mjs', dest: '.rig/hooks/guard-symlinked-node-modules.mjs' },
];

export function isSelfContainedRepo(targetDir) {
  if (!targetDir) return false;
  const dir = path.resolve(targetDir);
  return (
    existsSync(path.join(dir, '.rig/bin/rig.mjs')) ||
    existsSync(path.join(dir, 'skills')) ||
    existsSync(path.join(dir, '.gemini/skills')) ||
    existsSync(path.join(dir, '.claude/skills')) ||
    existsSync(path.join(dir, '.codex/skills')) ||
    existsSync(path.join(dir, '.cursor/skills'))
  );
}

function checkFilePending(srcPath, destPath, resolvedProfile = null, options = {}) {
  if (!existsSync(srcPath)) return false;
  if (!existsSync(destPath) || isSymlink(destPath)) return true;
  if (srcPath.endsWith('.md') && resolvedProfile) {
    const expected = getHydratedFileContent(srcPath, destPath, resolvedProfile, options);
    try {
      const actual = readFileSync(destPath, 'utf8');
      return actual !== expected;
    } catch {
      return true;
    }
  } else {
    try {
      const srcBuf = readFileSync(srcPath);
      const destBuf = readFileSync(destPath);
      return !srcBuf.equals(destBuf);
    } catch {
      return true;
    }
  }
}

function checkDirPending(srcDir, destDir, resolvedProfile, options, pendingFiles) {
  if (!existsSync(srcDir)) return;
  for (const entry of readdirSync(srcDir)) {
    const srcEntry = path.join(srcDir, entry);
    const destEntry = path.join(destDir, entry);
    const stat = lstatSync(srcEntry);
    if (stat.isDirectory()) {
      checkDirPending(srcEntry, destEntry, resolvedProfile, options, pendingFiles);
    } else if (stat.isFile()) {
      if (checkFilePending(srcEntry, destEntry, resolvedProfile, options)) {
        pendingFiles.push(destEntry);
      }
    }
  }
}

export function checkRepoPendingUpdates(targetDir, { harness = null, rigRoot = RIG_ROOT } = {}) {
  const dir = path.resolve(targetDir);
  if (!existsSync(dir)) {
    return { dir, hasPendingUpdates: false, pendingFiles: [] };
  }

  const pendingFiles = [];

  const legacyPreCommit = path.join(dir, 'scripts/git-hooks/pre-commit');
  const legacyPreMerge = path.join(dir, 'scripts/git-hooks/pre-merge-commit');
  if (existsSync(legacyPreCommit)) pendingFiles.push(legacyPreCommit);
  if (existsSync(legacyPreMerge)) pendingFiles.push(legacyPreMerge);

  let currentHooksPath = null;
  if (existsSync(path.join(dir, '.git'))) {
    const cfg = spawnSync('git', ['-C', dir, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
    if (cfg.status === 0) currentHooksPath = cfg.stdout.trim();
  }

  const hadLegacyHooksDir = existsSync(path.join(dir, 'scripts/git-hooks'));
  const hadLegacyHooks = existsSync(legacyPreCommit) || existsSync(legacyPreMerge);
  const shouldWriteRigHook =
    existsSync(path.join(dir, '.rig/hooks')) ||
    hadLegacyHooksDir ||
    hadLegacyHooks ||
    currentHooksPath === '.rig/hooks' ||
    currentHooksPath === 'scripts/git-hooks' ||
    existsSync(path.join(dir, '.rig'));

  if (shouldWriteRigHook || existsSync(path.join(dir, '.rig/hooks/pre-commit'))) {
    const targetPreCommit = path.join(dir, '.rig/hooks/pre-commit');
    const srcPreCommit = path.join(rigRoot, '.rig/hooks/pre-commit');
    if (checkFilePending(srcPreCommit, targetPreCommit)) {
      pendingFiles.push(targetPreCommit);
    }
  }

  const agentsPath = path.join(dir, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    try {
      const tHarness = harness || detectRepoHarness(dir) || 'antigravity';
      const resolvedProfile = resolveProfile(tHarness, { rigRoot });
      const isSelf = isSelfContainedRepo(dir);
      const expectedBlock = buildManagedAgentsBlock(resolvedProfile, { rigRoot, isSelfContained: isSelf });
      const content = readFileSync(agentsPath, 'utf8');
      const { block, hasBlock } = extractManagedAgentsBlock(content);
      if (!hasBlock || block.trim() !== expectedBlock.trim()) {
        pendingFiles.push(agentsPath);
      }
    } catch {
      // ignore
    }
  }

  const isSelfContained = isSelfContainedRepo(dir);

  if (isSelfContained) {
    if (existsSync(path.join(dir, '.rig/bin/rig.mjs')) || existsSync(path.join(dir, '.rig'))) {
      for (const f of VENDORED_RIG_FILES) {
        const destPath = path.join(dir, f.dest);
        const srcPath = path.join(rigRoot, f.src);
        if (checkFilePending(srcPath, destPath)) {
          pendingFiles.push(destPath);
        }
      }
    }

    const dotHarnessMap = {
      '.gemini': 'antigravity',
      '.claude': 'claude',
      '.codex': 'codex',
      '.cursor': 'cursor',
    };
    const targetHarnesses = [];
    if (harness) {
      targetHarnesses.push(harness);
    } else {
      for (const [dotDir, hId] of Object.entries(dotHarnessMap)) {
        if (existsSync(path.join(dir, dotDir))) {
          targetHarnesses.push(hId);
        }
      }
    }

    if (targetHarnesses.length > 0) {
      for (const tHarness of targetHarnesses) {
        const dotDirName = { antigravity: '.gemini', claude: '.claude', codex: '.codex', cursor: '.cursor' }[tHarness] || ('.' + tHarness);
        const dotDir = path.join(dir, dotDirName);
        const resolvedProfile = resolveProfile(tHarness, { rigRoot });
        const skillsDir = path.join(rigRoot, 'skills');
        if (existsSync(skillsDir)) {
          for (const skill of readdirSync(skillsDir)) {
            checkDirPending(
              path.join(skillsDir, skill),
              path.join(dotDir, 'skills', skill),
              resolvedProfile,
              { isGlobal: false, harness: tHarness, isDotHarness: true },
              pendingFiles,
            );
          }
        }
        const agentsDir = path.join(rigRoot, 'agents');
        if (existsSync(agentsDir)) {
          for (const agent of readdirSync(agentsDir)) {
            const src = path.join(rigRoot, 'agents', agent);
            const dest = path.join(dotDir, 'agents', agent);
            if (checkFilePending(src, dest, resolvedProfile, { isGlobal: false, harness: tHarness, isDotHarness: true })) {
              pendingFiles.push(dest);
            }
          }
        }
        const rulesDir = path.join(rigRoot, 'rules');
        if (existsSync(rulesDir)) {
          for (const rule of readdirSync(rulesDir)) {
            const src = path.join(rulesDir, rule);
            const dest = path.join(dotDir, 'rules', rule);
            if (checkFilePending(src, dest, resolvedProfile, { isGlobal: false, harness: tHarness, isDotHarness: true })) {
              pendingFiles.push(dest);
            }
          }
        }
        if (tHarness === 'claude') {
          const claudeHookFiles = [
            { src: 'hooks/lib/hook-io.mjs', dest: path.join(dotDir, 'hooks/lib/hook-io.mjs') },
            { src: 'hooks/guard-remote-mutation.mjs', dest: path.join(dotDir, 'hooks/guard-remote-mutation.mjs') },
            { src: 'hooks/guard-main-checkout-edits.mjs', dest: path.join(dotDir, 'hooks/guard-main-checkout-edits.mjs') },
            { src: 'hooks/guard-symlinked-node-modules.mjs', dest: path.join(dotDir, 'hooks/guard-symlinked-node-modules.mjs') },
          ];
          for (const cf of claudeHookFiles) {
            if (checkFilePending(path.join(rigRoot, cf.src), cf.dest)) {
              pendingFiles.push(cf.dest);
            }
          }
        }
      }
    } else if (existsSync(path.join(dir, 'skills'))) {
      const tHarness = harness || detectRepoHarness(dir) || 'claude';
      const resolvedProfile = resolveProfile(tHarness, { rigRoot });
      const skillsDir = path.join(rigRoot, 'skills');
      if (existsSync(skillsDir)) {
        for (const skill of readdirSync(skillsDir)) {
          checkDirPending(
            path.join(skillsDir, skill),
            path.join(dir, 'skills', skill),
            resolvedProfile,
            { isGlobal: false, harness: tHarness },
            pendingFiles,
          );
        }
      }
      const agentsDir = path.join(rigRoot, 'agents');
      if (existsSync(agentsDir)) {
        for (const agent of readdirSync(agentsDir)) {
          const src = path.join(rigRoot, 'agents', agent);
          const dest = path.join(dir, 'agents', agent);
          if (checkFilePending(src, dest, resolvedProfile, { isGlobal: false, harness: tHarness })) {
            pendingFiles.push(dest);
          }
        }
      }
      const rulesDir = path.join(rigRoot, 'rules');
      if (existsSync(rulesDir)) {
        for (const rule of readdirSync(rulesDir)) {
          const src = path.join(rigRoot, 'rules', rule);
          const dest = path.join(dir, 'rules', rule);
          if (checkFilePending(src, dest, resolvedProfile, { isGlobal: false, harness: tHarness })) {
            pendingFiles.push(dest);
          }
        }
      }
      for (const sc of ['scripts/check-doc-links.mjs', 'scripts/reflow-docs.mjs']) {
        const src = path.join(rigRoot, sc);
        const dest = path.join(dir, sc);
        if (checkFilePending(src, dest)) {
          pendingFiles.push(dest);
        }
      }
      if (existsSync(path.join(dir, 'hooks'))) {
        if (checkFilePending(path.join(rigRoot, 'hooks/lib/hook-io.mjs'), path.join(dir, 'hooks/lib/hook-io.mjs'))) {
          pendingFiles.push(path.join(dir, 'hooks/lib/hook-io.mjs'));
        }
        for (const hf of ['guard-remote-mutation.mjs', 'guard-main-checkout-edits.mjs', 'guard-symlinked-node-modules.mjs']) {
          if (existsSync(path.join(dir, 'hooks', hf))) {
            if (checkFilePending(path.join(rigRoot, 'hooks', hf), path.join(dir, 'hooks', hf))) {
              pendingFiles.push(path.join(dir, 'hooks', hf));
            }
          }
        }
      }
    }
  }

  const uniqueFiles = [...new Set(pendingFiles)];
  return {
    dir,
    hasPendingUpdates: uniqueFiles.length > 0,
    pendingFiles: uniqueFiles,
  };
}

export function validateRepoCleanForUpdate(targetDir) {
  const dir = path.resolve(targetDir);
  if (!existsSync(path.join(dir, '.git'))) {
    return { ok: true, reason: null, branch: 'main', message: null };
  }

  const headRev = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD'], { encoding: 'utf8' });
  const hasCommits = headRev.status === 0;

  const symRef = spawnSync('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8' });
  const branch = symRef.status === 0 && symRef.stdout ? symRef.stdout.trim() : null;

  if (hasCommits && branch !== 'main' && branch !== 'master') {
    return {
      ok: false,
      reason: 'non-main-branch',
      branch: branch || 'HEAD',
      message: `Skipping repository '${dir}': active branch is '${branch || 'detached HEAD'}' (must be on main or master to update).`,
    };
  }

  const status = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
  if (status.status === 0 && status.stdout.trim().length > 0) {
    return {
      ok: false,
      reason: 'dirty',
      branch: branch || 'main',
      message: `Skipping repository '${dir}': working tree has uncommitted changes.`,
    };
  }

  return { ok: true, reason: null, branch: branch || 'main', message: null };
}

export function updateRepo(targetDir, { harness = null, rigRoot = RIG_ROOT, autoCommit = false, homeDir = null } = {}) {
  const dir = path.resolve(targetDir);
  const copied = [];
  const skipped = [];
  const removed = [];

  const legacyPreCommit = path.join(dir, 'scripts/git-hooks/pre-commit');
  const legacyPreMerge = path.join(dir, 'scripts/git-hooks/pre-merge-commit');
  const hadLegacyHooksDir = existsSync(path.join(dir, 'scripts/git-hooks'));
  let hadLegacyHooks = false;

  if (existsSync(legacyPreCommit)) {
    rmSync(legacyPreCommit, { force: true });
    removed.push(legacyPreCommit);
    hadLegacyHooks = true;
  }
  if (existsSync(legacyPreMerge)) {
    rmSync(legacyPreMerge, { force: true });
    removed.push(legacyPreMerge);
    hadLegacyHooks = true;
  }
  const legacyDir = path.join(dir, 'scripts/git-hooks');
  if (existsSync(legacyDir)) {
    try {
      if (readdirSync(legacyDir).length === 0) {
        rmSync(legacyDir, { recursive: true, force: true });
        removed.push(legacyDir);
      }
    } catch {
      // ignore
    }
  }
  const scriptsDir = path.join(dir, 'scripts');
  if (existsSync(scriptsDir)) {
    try {
      if (readdirSync(scriptsDir).length === 0) {
        rmSync(scriptsDir, { recursive: true, force: true });
        removed.push(scriptsDir);
      }
    } catch {
      // ignore
    }
  }

  let currentHooksPath = null;
  if (existsSync(path.join(dir, '.git'))) {
    const cfg = spawnSync('git', ['-C', dir, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
    if (cfg.status === 0) currentHooksPath = cfg.stdout.trim();
  }

  const shouldWriteRigHook =
    existsSync(path.join(dir, '.rig/hooks')) ||
    hadLegacyHooksDir ||
    hadLegacyHooks ||
    currentHooksPath === '.rig/hooks' ||
    currentHooksPath === 'scripts/git-hooks';

  if (shouldWriteRigHook) {
    copyFileSafe(path.join(rigRoot, '.rig/hooks/pre-commit'), path.join(dir, '.rig/hooks/pre-commit'), {
      force: true,
      copied,
      skipped,
      executable: true,
    });
    if (existsSync(path.join(dir, '.git'))) {
      if (currentHooksPath === 'scripts/git-hooks' || (!currentHooksPath && (hadLegacyHooks || hadLegacyHooksDir))) {
        spawnSync('git', ['-C', dir, 'config', 'core.hooksPath', '.rig/hooks']);
      }
    }
  }

  const agentsPath = path.join(dir, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    try {
      const tHarness = harness || detectRepoHarness(dir) || 'antigravity';
      const resolvedProfile = resolveProfile(tHarness, { rigRoot });
      const isSelf = isSelfContainedRepo(dir);
      const expectedBlock = buildManagedAgentsBlock(resolvedProfile, { rigRoot, isSelfContained: isSelf });
      const docsBlock = buildDocsIndexBlock(dir);
      const existing = readFileSync(agentsPath, 'utf8');
      const updated = mergeManagedAgentsFile(existing, expectedBlock, '', docsBlock);
      if (updated !== existing) {
        writeFileSync(agentsPath, updated, 'utf8');
        copied.push(agentsPath);
      }
    } catch {
      // ignore
    }
  }

  const docsDir = path.join(dir, 'docs');
  if (existsSync(docsDir)) {
    try {
      if (statSync(docsDir).isDirectory()) {
        const colDirs = findCollectionDirs(docsDir);
        for (const cDir of colDirs) {
          const readmePath = path.join(cDir, 'README.md');
          if (existsSync(readmePath)) {
            const existing = readFileSync(readmePath, 'utf8');
            const expectedBlock = buildCollectionDocsIndexBlock(cDir, dir);
            if (expectedBlock) {
              const updated = updateDocManagedDocsBlock(existing, expectedBlock);
              if (updated !== existing) {
                writeFileSync(readmePath, updated, 'utf8');
                copied.push(readmePath);
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // If the repo was initialized with --self-contained, refresh static rig assets without touching AGENTS.md or docs/
  const isSelfContained = isSelfContainedRepo(dir);

  if (isSelfContained) {
    if (existsSync(path.join(dir, '.rig/bin/rig.mjs')) || existsSync(path.join(dir, '.rig'))) {
      copyFileSafe(path.join(rigRoot, 'bin/rig.mjs'), path.join(dir, '.rig/bin/rig.mjs'), {
        force: true,
        copied,
        skipped,
        executable: true,
      });
      copyFileSafe(path.join(rigRoot, 'templates/models.json'), path.join(dir, '.rig/templates/models.json'), {
        force: true,
        copied,
        skipped,
      });
      copyFileSafe(path.join(rigRoot, 'templates/rig-config.default.json'), path.join(dir, '.rig/templates/rig-config.default.json'), {
        force: true,
        copied,
        skipped,
      });
      copyFileSafe(path.join(rigRoot, 'scripts/check-doc-links.mjs'), path.join(dir, '.rig/scripts/check-doc-links.mjs'), {
        force: true,
        copied,
        skipped,
        executable: true,
      });
      copyFileSafe(path.join(rigRoot, 'scripts/reflow-docs.mjs'), path.join(dir, '.rig/scripts/reflow-docs.mjs'), {
        force: true,
        copied,
        skipped,
        executable: true,
      });
      copyFileSafe(path.join(rigRoot, 'hooks/lib/hook-io.mjs'), path.join(dir, '.rig/hooks/lib/hook-io.mjs'), {
        force: true,
        copied,
        skipped,
      });
      copyFileSafe(path.join(rigRoot, 'hooks/lib/hook-io.mjs'), path.join(dir, '.rig/hooks/hook-io.mjs'), {
        force: true,
        copied,
        skipped,
      });
      for (const hf of ['guard-remote-mutation.mjs', 'guard-main-checkout-edits.mjs', 'guard-symlinked-node-modules.mjs']) {
        copyFileSafe(path.join(rigRoot, 'hooks', hf), path.join(dir, '.rig/hooks', hf), {
          force: true,
          copied,
          skipped,
          executable: true,
        });
      }
    }

    const dotHarnessMap = {
      '.gemini': 'antigravity',
      '.claude': 'claude',
      '.codex': 'codex',
      '.cursor': 'cursor',
    };
    const targetHarnesses = [];
    if (harness) {
      targetHarnesses.push(harness);
    } else {
      for (const [dotDir, hId] of Object.entries(dotHarnessMap)) {
        if (existsSync(path.join(dir, dotDir))) {
          targetHarnesses.push(hId);
        }
      }
    }

    if (targetHarnesses.length > 0) {
      for (const tHarness of targetHarnesses) {
        const dotDirName = { antigravity: '.gemini', claude: '.claude', codex: '.codex', cursor: '.cursor' }[tHarness] || ('.' + tHarness);
        const dotDir = path.join(dir, dotDirName);
        const resolvedProfile = resolveProfile(tHarness, { rigRoot });
        const skillsDir = path.join(rigRoot, 'skills');
        for (const skill of readdirSync(skillsDir)) {
          copyOrHydrateDir(path.join(skillsDir, skill), path.join(dotDir, 'skills', skill), resolvedProfile, {
            hydrated: copied,
            isGlobal: false,
            harness: tHarness,
            isDotHarness: true,
          });
        }
        if (existsSync(path.join(rigRoot, 'agents'))) {
          for (const agent of readdirSync(path.join(rigRoot, 'agents'))) {
            const src = path.join(rigRoot, 'agents', agent);
            const dest = path.join(dotDir, 'agents', agent);
            if (agent.endsWith('.md')) {
              writeHydratedFile(src, dest, resolvedProfile, { isGlobal: false, harness: tHarness, isDotHarness: true });
              copied.push(dest);
            } else {
              copyFileSafe(src, dest, { force: true, copied, skipped });
            }
          }
        }
        if (existsSync(path.join(rigRoot, 'rules'))) {
          for (const rule of readdirSync(path.join(rigRoot, 'rules'))) {
            const src = path.join(rigRoot, 'rules', rule);
            const dest = path.join(dotDir, 'rules', rule);
            if (rule.endsWith('.md')) {
              writeHydratedFile(src, dest, resolvedProfile, { isGlobal: false, harness: tHarness, isDotHarness: true });
              copied.push(dest);
            } else {
              copyFileSafe(src, dest, { force: true, copied, skipped });
            }
          }
        }
        if (tHarness === 'claude') {
          copyFileSafe(path.join(rigRoot, 'hooks/lib/hook-io.mjs'), path.join(dotDir, 'hooks/lib/hook-io.mjs'), {
            force: true,
            copied,
            skipped,
          });
          for (const hf of ['guard-remote-mutation.mjs', 'guard-main-checkout-edits.mjs', 'guard-symlinked-node-modules.mjs']) {
            copyFileSafe(path.join(rigRoot, 'hooks', hf), path.join(dotDir, 'hooks', hf), {
              force: true,
              copied,
              skipped,
              executable: true,
            });
          }
        }
      }
    } else if (existsSync(path.join(dir, 'skills'))) {
      const tHarness = harness || detectRepoHarness(dir) || 'claude';
      const resolvedProfile = resolveProfile(tHarness, { rigRoot });
      const skillsDir = path.join(rigRoot, 'skills');
      for (const skill of readdirSync(skillsDir)) {
        copyOrHydrateDir(path.join(skillsDir, skill), path.join(dir, 'skills', skill), resolvedProfile, {
          hydrated: copied,
          isGlobal: false,
          harness: tHarness,
        });
      }
      if (existsSync(path.join(rigRoot, 'agents'))) {
        for (const agent of readdirSync(path.join(rigRoot, 'agents'))) {
          const src = path.join(rigRoot, 'agents', agent);
          const dest = path.join(dir, 'agents', agent);
          if (agent.endsWith('.md')) {
            writeHydratedFile(src, dest, resolvedProfile, { isGlobal: false, harness: tHarness });
            copied.push(dest);
          } else {
            copyFileSafe(src, dest, { force: true, copied, skipped });
          }
        }
      }
      if (existsSync(path.join(rigRoot, 'rules'))) {
        for (const rule of readdirSync(path.join(rigRoot, 'rules'))) {
          const src = path.join(rigRoot, 'rules', rule);
          const dest = path.join(dir, 'rules', rule);
          if (rule.endsWith('.md')) {
            writeHydratedFile(src, dest, resolvedProfile, { isGlobal: false, harness: tHarness });
            copied.push(dest);
          } else {
            copyFileSafe(src, dest, { force: true, copied, skipped });
          }
        }
      }
      copyFileSafe(path.join(rigRoot, 'scripts/check-doc-links.mjs'), path.join(dir, 'scripts/check-doc-links.mjs'), {
        force: true,
        copied,
        skipped,
        executable: true,
      });
      copyFileSafe(path.join(rigRoot, 'scripts/reflow-docs.mjs'), path.join(dir, 'scripts/reflow-docs.mjs'), {
        force: true,
        copied,
        skipped,
        executable: true,
      });
      if (existsSync(path.join(dir, 'hooks'))) {
        copyFileSafe(path.join(rigRoot, 'hooks/lib/hook-io.mjs'), path.join(dir, 'hooks/lib/hook-io.mjs'), {
          force: true,
          copied,
          skipped,
        });
        for (const hf of ['guard-remote-mutation.mjs', 'guard-main-checkout-edits.mjs', 'guard-symlinked-node-modules.mjs']) {
          if (existsSync(path.join(dir, 'hooks', hf))) {
            copyFileSafe(path.join(rigRoot, 'hooks', hf), path.join(dir, 'hooks', hf), {
              force: true,
              copied,
              skipped,
              executable: true,
            });
          }
        }
      }
    }
  }

  const attachRes = attachMainCheckout(dir);

  if (autoCommit && existsSync(path.join(dir, '.git'))) {
    const headRev = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD'], { encoding: 'utf8' });
    const hasHead = headRev.status === 0;
    const symRef = spawnSync('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8' });
    const branch = symRef.status === 0 && symRef.stdout ? symRef.stdout.trim() : null;
    const isOnMain = branch === 'main' || branch === 'master';

    if (hasHead && isOnMain) {
      const filesToStage = [
        ...new Set(
          [...copied, ...removed]
            .map((f) => path.relative(dir, f).replace(/\\/g, '/'))
            .filter((rel) => {
              if (!rel || rel.startsWith('..')) return false;
              const ign = spawnSync('git', ['-C', dir, 'check-ignore', '-q', rel]);
              return ign.status !== 0;
            }),
        ),
      ];

      if (filesToStage.length > 0) {
        spawnSync('git', ['-C', dir, 'add', '-A', '--', ...filesToStage], { encoding: 'utf8' });
        const diffRes = spawnSync('git', ['-C', dir, 'diff', '--cached', '--name-only'], { encoding: 'utf8' });
        if (diffRes.status === 0 && diffRes.stdout.trim().length > 0) {
          const localBin = homeDir ? path.join(homeDir, '.local', 'bin') : path.join(homedir(), '.local', 'bin');
          const nodeDir = path.dirname(process.execPath);
          const envPath = [localBin, nodeDir, process.env.PATH].filter(Boolean).join(':');
          const gitEnv = {
            ...process.env,
            ...(homeDir ? { HOME: homeDir } : {}),
            PATH: envPath,
          };
          const commitRes = spawnSync(
            'git',
            [
              '-C',
              dir,
              'commit',
              '-m',
              'chore(rig): update agent-rig repository assets',
              '-m',
              'Unmandated-call: none',
            ],
            { encoding: 'utf8', env: gitEnv },
          );
          if (commitRes.status === 0) {
            const headSha = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
            return { dir, copied, removed, attachRes, committed: true, commitSha: headSha };
          }
          return { dir, copied, removed, attachRes, committed: false, commitSha: null, commitError: commitRes.stderr };
        }
      }
    }
  }

  return { dir, copied, removed, attachRes, committed: false, commitSha: null };
}

export function updateRig({
  homeDir = homedir(),
  repoDir = null,
  allRepos = false,
  rigRoot = RIG_ROOT,
  nodeBin = null,
  harness = null,
} = {}) {
  const state = readRigState(homeDir);
  const resolvedNodeBin = nodeBin || resolveNodeBinary();
  const harnesses =
    state.installedHarnesses.length > 0
      ? state.installedHarnesses
      : detectHarnesses(homeDir)
          .filter((d) => d.detected)
          .map((d) => d.id);

  const globalRes = installRig({ homeDir, harnesses, force: false, rigRoot, nodeBin: resolvedNodeBin });

  let updatedRepos = [];
  let skippedRepos = [];
  let pendingRepos = [];
  let warnings = [];
  let notice = null;

  if (!repoDir && !allRepos) {
    for (const r of (state.initializedRepos || []).filter((p) => existsSync(p))) {
      const pending = checkRepoPendingUpdates(r, { harness, rigRoot });
      if (pending.hasPendingUpdates) {
        pendingRepos.push(pending);
      }
    }
    notice =
      pendingRepos.length > 0
        ? `Notice: ${pendingRepos.length} initialized repository(ies) have pending agent-rig updates (${pendingRepos.map((p) => p.dir).join(', ')}). Run 'rig update --all' or 'rig update --repo <dir>' to update them.`
        : null;
  } else {
    const targetRepos = repoDir
      ? [path.resolve(repoDir)]
      : (state.initializedRepos || []).filter((r) => existsSync(r));

    for (const r of targetRepos) {
      const check = validateRepoCleanForUpdate(r);
      if (!check.ok) {
        skippedRepos.push({ dir: r, reason: check.reason, warning: check.message });
        warnings.push(check.message);
      } else {
        const res = updateRepo(r, { harness, rigRoot, homeDir, autoCommit: true });
        updatedRepos.push(res);
        if (res.commitError) {
          warnings.push(`Warning: failed to auto-commit repository updates in '${r}': ${res.commitError.trim()}`);
        }
      }
    }
  }

  if (existsSync(path.join(rigRoot, '.git'))) {
    attachMainCheckout(rigRoot);
  }

  return {
    ...globalRes,
    updatedRepos,
    skippedRepos,
    pendingRepos,
    warnings,
    notice,
  };
}

export function listProfiles(rigRoot = RIG_ROOT) {
  const cfg = loadRigConfig(rigRoot);
  const profiles = cfg.profiles || {};
  const activeProfiles = cfg.activeProfiles || {};

  const summary = {
    activeProfiles,
    profiles: {},
  };

  for (const [name, prof] of Object.entries(profiles)) {
    const harness = prof.harness;
    const resolvedRoles = {};
    for (const role of ROLES) {
      const r = prof.roles?.[role];
      if (r) {
        resolvedRoles[role] = {
          model: r.model,
          subagentModel: resolveSubagentModel(harness, r.model, r.subagentModel, { rigRoot, userConfig: cfg }),
          effort: r.effort,
        };
      }
    }
    summary.profiles[name] = {
      harness,
      isActive: activeProfiles[harness] === name,
      roles: resolvedRoles,
    };
  }

  return summary;
}

export function useProfile(profileName, { rigRoot = RIG_ROOT, homeDir = homedir() } = {}) {
  const cfg = loadRigConfig(rigRoot);
  const profile = cfg.profiles?.[profileName];
  if (!profile) {
    throw new Error(`Profile not found: "${profileName}"`);
  }
  const harness = profile.harness;
  if (!harness) {
    throw new Error(`Profile "${profileName}" does not specify a harness`);
  }
  cfg.activeProfiles = cfg.activeProfiles || {};
  cfg.activeProfiles[harness] = profileName;
  writeRigConfig(cfg, rigRoot);
  const updateRes = updateRig({ homeDir, rigRoot });
  return { profileName, harness, updateRes };
}

export function setProfileRole(role, model, { effort = null, subagentModel = null, profileName = null, harness = null, rigRoot = RIG_ROOT, homeDir = homedir() } = {}) {
  if (!ROLES.includes(role)) {
    throw new Error(`Invalid role "${role}". Valid roles are: ${ROLES.join(', ')}`);
  }
  const cfg = loadRigConfig(rigRoot);
  let targetProfileName = profileName;
  if (!targetProfileName) {
    if (harness) {
      targetProfileName = cfg.activeProfiles?.[harness];
    } else {
      const activeList = Object.values(cfg.activeProfiles || {});
      if (activeList.length === 1) {
        targetProfileName = activeList[0];
      } else {
        throw new Error(`Specify --profile <name> or --harness <id> to choose which profile to update`);
      }
    }
  }

  const profile = cfg.profiles?.[targetProfileName];
  if (!profile) {
    throw new Error(`Profile not found: "${targetProfileName}"`);
  }

  const existingRole = profile.roles?.[role] || {};
  const newEffort = effort || existingRole.effort || 'medium';
  const validEfforts = ['low', 'medium', 'high', 'max'];
  if (!validEfforts.includes(newEffort)) {
    throw new Error(`Invalid effort "${newEffort}". Valid levels: ${validEfforts.join(', ')}`);
  }

  const resolvedSub = resolveSubagentModel(profile.harness, model, subagentModel || null, { rigRoot, userConfig: cfg });

  profile.roles = profile.roles || {};
  profile.roles[role] = {
    model,
    subagentModel: resolvedSub,
    effort: newEffort,
  };

  writeRigConfig(cfg, rigRoot);
  const updateRes = updateRig({ homeDir, rigRoot });
  return { profileName: targetProfileName, harness: profile.harness, role, model, subagentModel: resolvedSub, effort: newEffort, updateRes };
}

export function resolveRoleModel(role, { harness = null, profileName = null, rigRoot = RIG_ROOT } = {}) {
  if (!ROLES.includes(role)) {
    throw new Error(`Invalid role "${role}". Valid roles are: ${ROLES.join(', ')}`);
  }
  const cfg = loadRigConfig(rigRoot);
  let targetHarness = harness;
  if (!targetHarness) {
    if (profileName && cfg.profiles?.[profileName]) {
      targetHarness = cfg.profiles[profileName].harness;
    } else {
      targetHarness = 'antigravity';
    }
  }
  const resolvedProf = resolveProfile(targetHarness, { profileName, rigRoot, userConfig: cfg });
  const roleData = resolvedProf.roles[role];
  return {
    harness: targetHarness,
    profile: resolvedProf.profileName,
    role,
    ...roleData,
  };
}

async function promptForHarnesses(discovered) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Detected harnesses on this machine:\n');
    discovered.forEach((h, idx) => {
      const mark = h.detected ? '[✓ detected]' : '[  not found]';
      console.log(`  ${idx + 1}. ${h.id.padEnd(12)} ${mark} — ${h.label} (~${path.sep}${h.detectRel})`);
    });
    const defaultList = discovered.filter((h) => h.detected).map((h) => h.id).join(',');
    const answer = await rl.question(
      `\nEnter harness names or numbers to install (comma-separated) [${defaultList || 'antigravity'}]: `,
    );
    const trimmed = answer.trim();
    if (!trimmed) {
      return defaultList ? defaultList.split(',') : ['antigravity'];
    }
    if (trimmed.toLowerCase() === 'all') {
      return discovered.map((h) => h.id);
    }
    const chosen = [];
    for (const part of trimmed.split(',').map((s) => s.trim()).filter(Boolean)) {
      const num = Number(part);
      if (Number.isInteger(num) && num >= 1 && num <= discovered.length) {
        chosen.push(discovered[num - 1].id);
      } else {
        chosen.push(part.toLowerCase());
      }
    }
    return [...new Set(chosen)];
  } finally {
    rl.close();
  }
}

function gitOut(dir, args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

// Where `dir` sits in git: whether it is a repository at all, whether it is a linked worktree,
// whether it has commits, and the path of the main checkout.
export function worktreeInfo(dir) {
  if (!existsSync(dir) || gitOut(dir, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return { isRepo: false, isLinked: false, hasCommits: false, mainCheckout: null };
  }
  const gitDir = gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const commonDir = gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const list = gitOut(dir, ['worktree', 'list', '--porcelain']) ?? '';
  const first = /^worktree (.+)$/m.exec(list);
  return {
    isRepo: true,
    isLinked: Boolean(gitDir && commonDir && gitDir !== commonDir),
    hasCommits: gitOut(dir, ['rev-parse', '--verify', '-q', 'HEAD']) !== null,
    mainCheckout: first ? first[1] : dir,
  };
}

export function attachMainCheckout(targetDir) {
  const dir = path.resolve(targetDir);
  const info = worktreeInfo(dir);
  if (!info.isRepo) {
    return { attached: false, status: 'not-a-git-repo' };
  }
  if (!info.hasCommits) {
    return { attached: false, status: 'no-commits' };
  }
  const mainDir = info.mainCheckout || dir;
  const branchRes = spawnSync('git', ['-C', mainDir, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8' });
  const currentBranch = branchRes.status === 0 ? branchRes.stdout.trim() : null;
  if (currentBranch) {
    return { attached: true, status: 'already-attached', branch: currentBranch };
  }

  // Untracked files never block `git switch`, so only tracked changes count as dirty here;
  // otherwise freshly scaffolded rig files would block re-attaching to main.
  const statusRes = spawnSync('git', ['-C', mainDir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  if (statusRes.stdout.trim().length > 0) {
    return { attached: false, status: 'dirty' };
  }

  let sw = spawnSync('git', ['-C', mainDir, 'switch', '-q', 'main'], { encoding: 'utf8' });
  if (sw.status !== 0) {
    sw = spawnSync('git', ['-C', mainDir, 'switch', '-q', 'master'], { encoding: 'utf8' });
    if (sw.status !== 0) {
      return { attached: false, status: 'switch-failed', error: sw.stderr.trim() };
    }
    return { attached: true, status: 'attached', branch: 'master' };
  }
  return { attached: true, status: 'attached', branch: 'main' };
}

// Worktree hygiene for .gitignore: `.worktrees/` is ignored, and a `node_modules/` entry loses its
// trailing slash, because a trailing slash matches directories only and a worktree's
// `node_modules` is a symlink to the main checkout's.
export function normalizeGitignore(content) {
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  let changed = false;
  const out = lines.map((line) => {
    const m = /^(\/?node_modules)\/\s*$/.exec(line);
    if (m) {
      changed = true;
      return m[1];
    }
    return line;
  });
  if (!out.some((line) => /^\/?\.worktrees\/?\s*$/.test(line))) {
    out.push('.worktrees/');
    changed = true;
  }
  return { content: out.join('\n') + '\n', changed };
}

export const INIT_WORKTREE_SLUG = 'rig-init';
export const INIT_WORKTREE_BRANCH = 'chore/rig-init';

// The pre-commit hook refuses commits in the main checkout, so scaffolding written there could
// never be committed. In a repository with history, `rig init` scaffolds into a linked worktree.
function ensureInitWorktree(mainDir) {
  const wtPath = path.join(mainDir, '.worktrees', INIT_WORKTREE_SLUG);
  if (existsSync(wtPath)) {
    const info = worktreeInfo(wtPath);
    if (!info.isLinked) throw new Error(`${wtPath} exists and is not a linked git worktree`);
    return { path: wtPath, branch: gitOut(wtPath, ['symbolic-ref', '--short', '-q', 'HEAD']), reused: true };
  }
  const branchExists = gitOut(mainDir, ['rev-parse', '--verify', '-q', `refs/heads/${INIT_WORKTREE_BRANCH}`]) !== null;
  const args = branchExists
    ? ['worktree', 'add', '-q', wtPath, INIT_WORKTREE_BRANCH]
    : ['worktree', 'add', '-q', '-b', INIT_WORKTREE_BRANCH, wtPath, 'HEAD'];
  const res = spawnSync('git', ['-C', mainDir, ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git worktree add failed: ${res.stderr.trim()}`);
  const nodeModules = path.join(mainDir, 'node_modules');
  if (existsSync(nodeModules) && !isSymlink(nodeModules)) {
    symlinkSync('../../node_modules', path.join(wtPath, 'node_modules'));
  }
  return { path: wtPath, branch: INIT_WORKTREE_BRANCH, reused: false };
}

export function detectExistingHookManager(dir, mainDir = null) {
  const dirsToCheck = [dir];
  if (mainDir && mainDir !== dir) {
    dirsToCheck.push(mainDir);
  }

  // 1. Inspect git config core.hooksPath
  for (const d of dirsToCheck) {
    if (existsSync(path.join(d, '.git'))) {
      const res = spawnSync('git', ['-C', d, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
      if (res.status === 0 && res.stdout.trim()) {
        const hooksPath = res.stdout.trim();
        const normalized = hooksPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        const isRigHooks =
          normalized === '.rig/hooks' ||
          normalized === 'scripts/git-hooks' ||
          normalized.endsWith('/.rig/hooks') ||
          normalized.endsWith('/scripts/git-hooks') ||
          path.resolve(d, hooksPath) === path.resolve(d, '.rig/hooks') ||
          path.resolve(d, hooksPath) === path.resolve(d, 'scripts/git-hooks');
        if (!isRigHooks) {
          let name = 'Custom core.hooksPath';
          let type = 'custom';
          if (hooksPath.includes('husky')) {
            name = 'Husky';
            type = 'husky';
          } else if (hooksPath.includes('lefthook')) {
            name = 'Lefthook';
            type = 'lefthook';
          }
          return { type, name, path: hooksPath };
        }
      }
    }
  }

  // 2. Inspect filesystem for known runner artifacts
  for (const d of dirsToCheck) {
    if (!existsSync(d)) continue;

    // Husky
    const huskyDir = path.join(d, '.husky');
    if (existsSync(huskyDir)) {
      return { type: 'husky', name: 'Husky', path: '.husky' };
    }

    // Lefthook
    for (const lf of ['.lefthook', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml']) {
      if (existsSync(path.join(d, lf))) {
        return { type: 'lefthook', name: 'Lefthook', path: lf };
      }
    }

    // pre-commit (Python)
    for (const pc of ['.pre-commit-config.yaml', '.pre-commit-config.yml']) {
      if (existsSync(path.join(d, pc))) {
        return { type: 'pre-commit', name: 'pre-commit', path: pc };
      }
    }
  }

  return null;
}

export function getHookChainingGuidance(manager) {
  if (!manager) return '';
  switch (manager.type) {
    case 'husky':
      return [
        'To chain agent-rig with Husky, add the following line to .husky/pre-commit:',
        '  ./.rig/hooks/pre-commit "$@"',
      ].join('\n');
    case 'lefthook':
      return [
        'To chain agent-rig with Lefthook, add the following to lefthook.yml:',
        '  pre-commit:',
        '    commands:',
        '      agent-rig:',
        '        run: ./.rig/hooks/pre-commit',
      ].join('\n');
    case 'pre-commit':
      return [
        'To chain agent-rig with pre-commit, add the following to .pre-commit-config.yaml:',
        '  - repo: local',
        '    hooks:',
        '      - id: agent-rig',
        '        name: agent-rig pre-commit',
        '        entry: ./.rig/hooks/pre-commit',
        '        language: system',
        '        always_run: true',
        '        pass_filenames: false',
      ].join('\n');
    default:
      return [
        `To chain agent-rig with your existing hooks in '${manager.path}':`,
        '  Call ./.rig/hooks/pre-commit from your existing pre-commit hook script.',
      ].join('\n');
  }
}

export function attachRepo(targetDir = process.cwd(), { homeDir = homedir(), force = false, rigRoot = RIG_ROOT } = {}) {
  const requestedDir = path.resolve(targetDir || process.cwd());
  const where = worktreeInfo(requestedDir);
  if (!where.isRepo) {
    throw new Error(`Target directory is not a git repository: ${requestedDir}`);
  }

  const mainCheckout = where.mainCheckout || requestedDir;

  const existingHookManager = detectExistingHookManager(mainCheckout, mainCheckout);
  let hooksConfigured = false;
  let hookWarning = null;
  let chainingGuidance = null;

  if (existingHookManager && !force) {
    chainingGuidance = getHookChainingGuidance(existingHookManager);
    hookWarning = `Existing git hook manager detected (${existingHookManager.name} at '${existingHookManager.path}'). Preserving existing hook configuration.\n${chainingGuidance}`;
    hooksConfigured = false;
  } else {
    const cfg = spawnSync('git', ['-C', mainCheckout, 'config', 'core.hooksPath', '.rig/hooks'], { encoding: 'utf8' });
    hooksConfigured = cfg.status === 0;
  }

  const hookPath = path.join(mainCheckout, '.rig/hooks/pre-commit');
  if (!existsSync(hookPath)) {
    if (existsSync(path.join(mainCheckout, '.rig')) || existsSync(path.join(mainCheckout, 'AGENTS.md'))) {
      const srcHook = path.join(rigRoot, '.rig/hooks/pre-commit');
      if (existsSync(srcHook)) {
        mkdirSync(path.dirname(hookPath), { recursive: true });
        copyFileSync(srcHook, hookPath);
        try {
          chmodSync(hookPath, 0o755);
        } catch {
          // ignore
        }
      }
    }
  }

  const mainCheckoutHead = attachMainCheckout(mainCheckout);

  if (homeDir !== false) {
    writeRigState(homeDir || homedir(), { initializedRepos: [mainCheckout] });
  }

  return {
    dir: mainCheckout,
    hooksConfigured,
    existingHookManager,
    hookWarning,
    chainingGuidance,
    mainCheckoutHead,
    hasCommits: where.hasCommits,
  };
}

export function initRepo(
  targetDir,
  { selfContained = false, worktrees = true, ui = false, force = false, homeDir = null, harness = null, stealth = false, rigRoot = RIG_ROOT } = {},
) {
  const requestedDir = path.resolve(targetDir);
  mkdirSync(requestedDir, { recursive: true });

  let where = worktreeInfo(requestedDir);
  if (!where.isRepo) {
    spawnSync('git', ['-C', requestedDir, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
    where = worktreeInfo(requestedDir);
  }

  const mainCheckout = where.isRepo ? where.mainCheckout : requestedDir;

  if (stealth && where.isRepo) {
    const lsRes = spawnSync('git', ['-C', mainCheckout, 'ls-files', '--error-unmatch', 'AGENTS.md'], { encoding: 'utf8' });
    if (lsRes.status === 0) {
      throw new Error(
        'Cannot initialize in stealth mode: AGENTS.md is already tracked in Git. Committing a team AGENTS.md defines the project agentic workflow.',
      );
    }
  }

  if (
    !force &&
    !stealth &&
    requestedDir === mainCheckout &&
    !existsSync(path.join(mainCheckout, '.worktrees', INIT_WORKTREE_SLUG)) &&
    (existsSync(path.join(mainCheckout, '.rig/hooks/pre-commit')) ||
      existsSync(path.join(mainCheckout, 'AGENTS.md')) ||
      existsSync(path.join(mainCheckout, '.rig')))
  ) {
    const effectiveHome = homeDir === false ? false : (homeDir || homedir());
    const attachRes = attachRepo(requestedDir, { homeDir: effectiveHome, force, rigRoot });
    return {
      ...attachRes,
      delegatedToAttach: true,
      dir: mainCheckout,
      copied: [],
      skipped: [],
      merged: [],
      staged: [],
      initWorktree: null,
    };
  }

  let initWorktree = null;
  if (!stealth && worktrees && where.isRepo && !where.isLinked && where.hasCommits) {
    initWorktree = ensureInitWorktree(requestedDir);
  }
  const dir = initWorktree ? initWorktree.path : requestedDir;

  const copied = [];
  const skipped = [];
  const merged = [];

  copyFileSafe(path.join(RIG_ROOT, 'templates/docs/backlog.md'), path.join(dir, 'docs/backlog.md'), {
    force,
    copied,
    skipped,
  });
  copyFileSafe(
    path.join(RIG_ROOT, 'templates/docs/adr/0001-record-architecture-decisions.md'),
    path.join(dir, 'docs/adr/0001-record-architecture-decisions.md'),
    { force, copied, skipped },
  );


  if (ui) {
    copyFileSafe(
      path.join(RIG_ROOT, 'templates/docs/design/mockup-scaffold.html'),
      path.join(dir, 'docs/design/mockup-scaffold.html'),
      { force, copied, skipped },
    );
  }

  let hooksConfigured = false;
  let existingHookManager = null;
  let hookWarning = null;
  let chainingGuidance = null;

  if (worktrees || stealth) {
    copyFileSafe(path.join(rigRoot, '.rig/hooks/pre-commit'), path.join(dir, '.rig/hooks/pre-commit'), {
      force,
      copied,
      skipped,
      executable: true,
    });

    existingHookManager = detectExistingHookManager(dir, mainCheckout);

    if (existsSync(path.join(dir, '.git')) || existsSync(path.join(mainCheckout, '.git'))) {
      if (existingHookManager && !force) {
        chainingGuidance = getHookChainingGuidance(existingHookManager);
        hookWarning = `Existing git hook manager detected (${existingHookManager.name} at '${existingHookManager.path}'). Preserving existing hook configuration.\n${chainingGuidance}`;
        hooksConfigured = false;
      } else {
        const cfg = spawnSync('git', ['-C', dir, 'config', 'core.hooksPath', '.rig/hooks']);
        hooksConfigured = cfg.status === 0;
      }
    }

    if (!stealth) {
      const gitignorePath = path.join(dir, '.gitignore');
      const before = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
      const normalized = normalizeGitignore(before);
      if (normalized.changed) {
        writeFileSync(gitignorePath, normalized.content, 'utf8');
        merged.push(gitignorePath);
      }
    }
  }

  if (stealth && where.isRepo) {
    let gitCommonDir = null;
    const cRes = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
    if (cRes.status === 0 && cRes.stdout.trim()) {
      gitCommonDir = cRes.stdout.trim();
    } else {
      gitCommonDir = path.join(mainCheckout, '.git');
    }
    if (gitCommonDir && existsSync(gitCommonDir)) {
      const infoDir = path.join(gitCommonDir, 'info');
      mkdirSync(infoDir, { recursive: true });
      const excludePath = path.join(infoDir, 'exclude');
      const existingExclude = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
      if (!existingExclude.includes('# agent-rig stealth exclude')) {
        const stealthEntries = [
          '',
          '# agent-rig stealth exclude',
          '.rig/',
          '.worktrees/',
          'AGENTS.md',
          'docs/backlog.md',
          'docs/adr/0001-record-architecture-decisions.md',
          '',
        ].join('\n');
        writeFileSync(excludePath, existingExclude ? existingExclude.trimEnd() + '\n' + stealthEntries : stealthEntries, 'utf8');
      }
    }
  }

  if (selfContained) {
    let targetHarnesses = [];
    if (harness) {
      targetHarnesses = harness.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      const checkedDirs = [dir];
      if (mainCheckout && mainCheckout !== dir) checkedDirs.push(mainCheckout);
      const repoDetected = new Set();
      for (const d of checkedDirs) {
        if (existsSync(path.join(d, '.gemini'))) repoDetected.add('antigravity');
        if (existsSync(path.join(d, '.claude')) || existsSync(path.join(d, '.claude-plugin'))) repoDetected.add('claude');
        if (existsSync(path.join(d, '.codex'))) repoDetected.add('codex');
        if (existsSync(path.join(d, '.cursor'))) repoDetected.add('cursor');
      }
      if (repoDetected.size > 0) {
        targetHarnesses = [...repoDetected];
      } else if (homeDir) {
        targetHarnesses = detectHarnesses(homeDir).filter((d) => d.detected).map((d) => d.id);
      }
    }
    if (targetHarnesses.length === 0) {
      throw new Error(
        'No harness detected or specified for --self-contained mode. Pass --harness <antigravity|claude|codex|cursor> or create a harness dot-directory first.',
      );
    }

    const dotHarnessMap = {
      antigravity: '.gemini',
      claude: '.claude',
      codex: '.codex',
      cursor: '.cursor',
    };

    for (const tHarness of targetHarnesses) {
      const dotDirName = dotHarnessMap[tHarness] || ('.' + tHarness);
      const dotDir = path.join(dir, dotDirName);
      const resolvedProfile = resolveProfile(tHarness, { rigRoot });
      const skillsDir = path.join(rigRoot, 'skills');
      for (const skill of readdirSync(skillsDir)) {
        copyOrHydrateDir(path.join(skillsDir, skill), path.join(dotDir, 'skills', skill), resolvedProfile, {
          hydrated: copied,
          isGlobal: false,
          harness: tHarness,
          isDotHarness: true,
        });
      }
      const agentsDir = path.join(rigRoot, 'agents');
      if (existsSync(agentsDir)) {
        for (const agent of readdirSync(agentsDir)) {
          const src = path.join(agentsDir, agent);
          const dest = path.join(dotDir, 'agents', agent);
          if (agent.endsWith('.md')) {
            writeHydratedFile(src, dest, resolvedProfile, { isGlobal: false, harness: tHarness, isDotHarness: true });
            copied.push(dest);
          } else {
            copyFileSafe(src, dest, { force: true, copied, skipped });
          }
        }
      }
      const rulesDir = path.join(rigRoot, 'rules');
      if (existsSync(rulesDir)) {
        for (const rule of readdirSync(rulesDir)) {
          const src = path.join(rulesDir, rule);
          const dest = path.join(dotDir, 'rules', rule);
          if (rule.endsWith('.md')) {
            writeHydratedFile(src, dest, resolvedProfile, { isGlobal: false, harness: tHarness, isDotHarness: true });
            copied.push(dest);
          } else {
            copyFileSafe(src, dest, { force: true, copied, skipped });
          }
        }
      }

      if (tHarness === 'claude') {
        copyFileSafe(path.join(rigRoot, 'hooks/lib/hook-io.mjs'), path.join(dotDir, 'hooks/lib/hook-io.mjs'), {
          force,
          copied,
          skipped,
        });
        const hookFiles = worktrees
          ? ['guard-remote-mutation.mjs', 'guard-main-checkout-edits.mjs', 'guard-symlinked-node-modules.mjs']
          : ['guard-remote-mutation.mjs'];
        for (const hf of hookFiles) {
          copyFileSafe(path.join(rigRoot, 'hooks', hf), path.join(dotDir, 'hooks', hf), {
            force,
            copied,
            skipped,
            executable: true,
          });
        }

        const templateSettings = JSON.parse(
          readFileSync(
            path.join(rigRoot, worktrees ? 'templates/claude/settings.worktree.json' : 'templates/claude/settings.minimal.json'),
            'utf8',
          ),
        );
        const settingsDest = path.join(dotDir, 'settings.json');
        if (existsSync(settingsDest) && !force) {
          const existing = JSON.parse(readFileSync(settingsDest, 'utf8'));
          const combined = mergeClaudeSettings(existing, templateSettings);
          writeFileSync(settingsDest, JSON.stringify(combined, null, 2) + '\n', 'utf8');
          merged.push(settingsDest);
        } else {
          mkdirSync(path.dirname(settingsDest), { recursive: true });
          writeFileSync(settingsDest, JSON.stringify(templateSettings, null, 2) + '\n', 'utf8');
          copied.push(settingsDest);
        }
      }
    }
  }

  copyFileSafe(path.join(rigRoot, 'bin/rig.mjs'), path.join(dir, '.rig/bin/rig.mjs'), {
    force,
    copied,
    skipped,
    executable: true,
  });
  copyFileSafe(path.join(rigRoot, 'rules/AGENTS.md'), path.join(dir, '.rig/rules/AGENTS.md'), {
    force,
    copied,
    skipped,
  });
  copyFileSafe(path.join(rigRoot, 'templates/models.json'), path.join(dir, '.rig/templates/models.json'), {
    force,
    copied,
    skipped,
  });
  copyFileSafe(path.join(rigRoot, 'templates/rig-config.default.json'), path.join(dir, '.rig/templates/rig-config.default.json'), {
    force,
    copied,
    skipped,
  });
  copyFileSafe(path.join(rigRoot, 'scripts/check-doc-links.mjs'), path.join(dir, '.rig/scripts/check-doc-links.mjs'), {
    force,
    copied,
    skipped,
    executable: true,
  });
  copyFileSafe(path.join(rigRoot, 'scripts/reflow-docs.mjs'), path.join(dir, '.rig/scripts/reflow-docs.mjs'), {
    force,
    copied,
    skipped,
    executable: true,
  });
  copyFileSafe(path.join(rigRoot, 'hooks/lib/hook-io.mjs'), path.join(dir, '.rig/hooks/lib/hook-io.mjs'), {
    force,
    copied,
    skipped,
  });
  copyFileSafe(path.join(rigRoot, 'hooks/lib/hook-io.mjs'), path.join(dir, '.rig/hooks/hook-io.mjs'), {
    force,
    copied,
    skipped,
  });
  const rigHookFiles = worktrees
    ? ['guard-remote-mutation.mjs', 'guard-main-checkout-edits.mjs', 'guard-symlinked-node-modules.mjs']
    : ['guard-remote-mutation.mjs'];
  for (const hf of rigHookFiles) {
    copyFileSafe(path.join(rigRoot, 'hooks', hf), path.join(dir, '.rig/hooks', hf), {
      force,
      copied,
      skipped,
      executable: true,
    });
  }

  const targetHarness = harness || detectRepoHarness(dir) || 'antigravity';
  const resolvedProfile = resolveProfile(targetHarness, { rigRoot });
  const managedBlock = buildManagedAgentsBlock(resolvedProfile, { rigRoot, isSelfContained: Boolean(selfContained) });
  const templateProjContext = readFileSync(path.join(rigRoot, 'templates/AGENTS.md'), 'utf8');

  const agentsPath = path.join(dir, 'AGENTS.md');
  const existingAgents = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  if (existingAgents && !force && !stealth) {
    const { hasBlock } = extractManagedAgentsBlock(existingAgents);
    if (!hasBlock) {
      throw new Error(
        'Existing unrigged AGENTS.md detected. Pass --force to merge agent-rig rules into it, or consult skills/rig-onboard/SKILL.md.',
      );
    }
  }
  const docsBlock = buildDocsIndexBlock(dir);
  const mergedAgents = mergeManagedAgentsFile(existingAgents, managedBlock, templateProjContext, docsBlock);
  writeFileSync(agentsPath, mergedAgents, 'utf8');
  copied.push(agentsPath);

  const initDocsDir = path.join(dir, 'docs');
  if (existsSync(initDocsDir)) {
    try {
      if (statSync(initDocsDir).isDirectory()) {
        const colDirs = findCollectionDirs(initDocsDir);
        for (const cDir of colDirs) {
          const readmePath = path.join(cDir, 'README.md');
          if (existsSync(readmePath)) {
            const existing = readFileSync(readmePath, 'utf8');
            const expectedBlock = buildCollectionDocsIndexBlock(cDir, dir);
            if (expectedBlock) {
              const updated = updateDocManagedDocsBlock(existing, expectedBlock);
              if (updated !== existing) {
                writeFileSync(readmePath, updated, 'utf8');
                copied.push(readmePath);
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (homeDir !== false) {
    writeRigState(homeDir || homedir(), { initializedRepos: [mainCheckout] });
  }

  // Stage what rig init wrote, so `rig check-docs` (which only trusts tracked files) passes at once
  // and the next step is a plain `git commit`. Nothing is committed here.
  let staged = [];
  if (where.isRepo && !stealth) {
    staged = [...copied, ...merged]
      .map((p) => path.relative(dir, p))
      .filter((p) => p && !p.startsWith('..'));
    if (staged.length > 0) {
      const add = spawnSync('git', ['-C', dir, 'add', '--', ...staged], { encoding: 'utf8' });
      if (add.status !== 0) staged = [];
    }
  }

  const mainCheckoutHead = worktrees && where.isRepo && !stealth
    ? attachMainCheckout(mainCheckout)
    : { attached: false, status: worktrees && !stealth ? 'not-a-git-repo' : 'skipped' };

  return {
    dir,
    copied,
    skipped,
    merged,
    staged,
    hooksConfigured,
    existingHookManager,
    hookWarning,
    chainingGuidance,
    mainCheckoutHead,
    initWorktree,
    hasCommits: where.hasCommits,
  };
}

export function ejectRepo(targetDir = process.cwd(), { homeDir = homedir() } = {}) {
  const dir = path.resolve(targetDir || process.cwd());
  const where = worktreeInfo(dir);
  const mainCheckout = where.isRepo ? where.mainCheckout : dir;

  let hooksUnset = false;
  if (where.isRepo) {
    const res = spawnSync('git', ['-C', mainCheckout, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      const hooksPath = res.stdout.trim();
      const normalized = hooksPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      const isRigHooks =
        normalized === '.rig/hooks' ||
        normalized === 'scripts/git-hooks' ||
        normalized.endsWith('/.rig/hooks') ||
        normalized.endsWith('/scripts/git-hooks') ||
        path.resolve(mainCheckout, hooksPath) === path.resolve(mainCheckout, '.rig/hooks') ||
        path.resolve(mainCheckout, hooksPath) === path.resolve(mainCheckout, 'scripts/git-hooks');
      if (isRigHooks) {
        const unsetRes = spawnSync('git', ['-C', mainCheckout, 'config', '--unset', 'core.hooksPath'], { encoding: 'utf8' });
        hooksUnset = unsetRes.status === 0;
      }
    }

    const cRes = spawnSync('git', ['-C', mainCheckout, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
    const gitCommonDir = cRes.status === 0 && cRes.stdout.trim() ? cRes.stdout.trim() : path.join(mainCheckout, '.git');
    if (existsSync(gitCommonDir)) {
      const excludePath = path.join(gitCommonDir, 'info', 'exclude');
      if (existsSync(excludePath)) {
        try {
          const text = readFileSync(excludePath, 'utf8');
          if (text.includes('# agent-rig stealth exclude')) {
            const lines = text.split('\n');
            const filtered = [];
            let inStealthBlock = false;
            for (const line of lines) {
              if (line.trim() === '# agent-rig stealth exclude') {
                inStealthBlock = true;
                continue;
              }
              if (inStealthBlock) {
                if (['.rig/', '.worktrees/', 'AGENTS.md', 'docs/backlog.md', 'docs/adr/0001-record-architecture-decisions.md', ''].includes(line.trim())) {
                  continue;
                } else {
                  inStealthBlock = false;
                }
              }
              filtered.push(line);
            }
            writeFileSync(excludePath, filtered.join('\n').trim() ? filtered.join('\n').trim() + '\n' : '', 'utf8');
          }
        } catch {
          // ignore
        }
      }
    }
  }

  const candidateDirs = [
    path.join(mainCheckout, '.rig'),
    path.join(mainCheckout, 'scripts/git-hooks'),
  ];
  if (dir !== mainCheckout) {
    candidateDirs.push(path.join(dir, '.rig'), path.join(dir, 'scripts/git-hooks'));
  }
  const removedPaths = [];
  const seen = new Set();
  for (const p of candidateDirs) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (existsSync(p) || isSymlink(p)) {
      rmSync(p, { recursive: true, force: true });
      removedPaths.push(p);
    }
  }

  let stateRemoved = false;
  if (homeDir !== false) {
    const effectiveHome = homeDir || homedir();
    const current = readRigState(effectiveHome);
    const targets = new Set([mainCheckout, dir]);
    const updatedRepos = current.initializedRepos.filter((r) => {
      const resolved = path.resolve(r);
      return !targets.has(r) && !targets.has(resolved);
    });
    if (updatedRepos.length < current.initializedRepos.length) {
      writeRigState(effectiveHome, { initializedRepos: updatedRepos }, { replace: true });
      stateRemoved = true;
    }
  }

  return {
    dir: mainCheckout,
    hooksUnset,
    removedPaths,
    stateRemoved,
  };
}

export function statusRepo(targetDir = process.cwd()) {
  const dir = path.resolve(targetDir);
  const skillDirs = [
    path.join(dir, 'skills'),
    path.join(dir, '.gemini/skills'),
    path.join(dir, '.claude/skills'),
    path.join(dir, '.codex/skills'),
    path.join(dir, '.cursor/skills'),
  ];
  const skillSet = new Set();
  for (const sd of skillDirs) {
    if (existsSync(sd)) {
      try {
        for (const s of readdirSync(sd)) skillSet.add(s);
      } catch {
        // ignore
      }
    }
  }
  const skillsPresent = [...skillSet];

  const hookDirs = [
    path.join(dir, '.rig/hooks'),
    path.join(dir, 'hooks'),
    path.join(dir, '.claude/hooks'),
    path.join(dir, '.gemini/hooks'),
    path.join(dir, '.codex/hooks'),
    path.join(dir, '.cursor/hooks'),
  ];
  const hookSet = new Set();
  for (const hd of hookDirs) {
    if (existsSync(hd)) {
      try {
        for (const h of readdirSync(hd)) {
          if (h.startsWith('guard-')) hookSet.add(h);
        }
      } catch {
        // ignore
      }
    }
  }
  const hooksPresent = [...hookSet];

  let gitHooksPath = null;
  if (existsSync(path.join(dir, '.git'))) {
    const res = spawnSync('git', ['-C', dir, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
    if (res.status === 0) gitHooksPath = res.stdout.trim();
  }

  return {
    dir,
    hasAgentsMd: existsSync(path.join(dir, 'AGENTS.md')),
    hasBacklog: existsSync(path.join(dir, 'docs/backlog.md')),
    skillsPresent,
    hooksPresent,
    gitHooksPath,
    existingHookManager: detectExistingHookManager(dir),
  };
}

function resolveDocScript(scriptName, targetDir = process.cwd()) {
  const candidates = [
    path.join(RIG_ROOT, 'scripts', scriptName),
    path.join(RIG_ROOT, '../scripts', scriptName),
    path.join(targetDir, '.rig/scripts', scriptName),
    path.join(targetDir, 'scripts', scriptName),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return path.join(RIG_ROOT, 'scripts', scriptName);
}

export function runCheckDocs(targetDir = process.cwd(), { fix = false } = {}) {
  const script = resolveDocScript('check-doc-links.mjs', targetDir);
  const args = [script, path.resolve(targetDir)];
  if (fix) args.push('--fix');
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

export function runReflowDocs(targetDir = process.cwd(), { check = false } = {}) {
  const script = resolveDocScript('reflow-docs.mjs', targetDir);
  const args = [script, path.resolve(targetDir)];
  if (check) args.push('--check');
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

export function runPreCommitHook(targetDir = process.cwd()) {
  const dir = path.resolve(targetDir);
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

  const revRes = git('rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel');
  if (revRes.status !== 0) {
    return { status: 0, stdout: '', stderr: '' };
  }
  const lines = revRes.stdout.trim().split('\n');
  const gitDir = lines[0];
  const commonDir = lines[1];
  const repoRoot = lines[2] || dir;

  // Initial commit on an unborn repository is always allowed in the main checkout
  const headRes = git('rev-parse', '--verify', '-q', 'HEAD');
  if (headRes.status !== 0) {
    return { status: 0, stdout: '', stderr: '' };
  }

  // Verify managed block integrity whenever AGENTS.md is staged in any checkout/worktree
  const stagedDiff = git('diff', '--cached', '--name-status', '--no-renames');
  const rawStaged = stagedDiff.stdout.trim();
  const stagedLines = rawStaged ? rawStaged.split('\n').filter(Boolean) : [];
  const agentsLine = stagedLines.find((l) => {
    const tabIdx = l.indexOf('\t');
    if (tabIdx === -1) return false;
    return l.slice(tabIdx + 1).trim().replace(/\\/g, '/') === 'AGENTS.md';
  });

  if (agentsLine) {
    const status = agentsLine.slice(0, agentsLine.indexOf('\t')).trim();
    if (status !== 'D') {
      const stagedShow = git('show', ':AGENTS.md');
      if (stagedShow.status === 0) {
        const { block: stagedBlock, hasBlock: stagedHasBlock } = extractManagedAgentsBlock(stagedShow.stdout);
        if (stagedHasBlock) {
          let matches = false;
          const headShow = git('show', 'HEAD:AGENTS.md');
          if (headShow.status === 0) {
            const { block: headBlock, hasBlock: headHasBlock } = extractManagedAgentsBlock(headShow.stdout);
            if (headHasBlock && headBlock.trim() === stagedBlock.trim()) {
              matches = true;
            }
          }
          if (!matches) {
            try {
              const tHarness = detectRepoHarness(repoRoot) || 'antigravity';
              const resolvedProfile = resolveProfile(tHarness, { rigRoot: RIG_ROOT });
              const isSelf = isSelfContainedRepo(repoRoot);
              const canonicalBlock = buildManagedAgentsBlock(resolvedProfile, { rigRoot: RIG_ROOT, isSelfContained: isSelf });
              if (canonicalBlock.trim() === stagedBlock.trim()) {
                matches = true;
              }
            } catch {
              // ignore
            }
          }
          if (!matches) {
            return {
              status: 1,
              stdout: '',
              stderr:
                'pre-commit: refusing commit with modified agent-rig managed block in AGENTS.md.\n' +
                'The block between <!-- AGENT-RIG:START --> and <!-- AGENT-RIG:END --> is managed by agent-rig.\n' +
                "Run 'rig update' to refresh it, or restore the block from HEAD.\n",
            };
          }
        }

        const { block: stagedDocsBlock, hasBlock: stagedHasDocsBlock } = extractManagedDocsBlock(stagedShow.stdout);
        if (stagedHasDocsBlock) {
          let docsMatches = false;
          const headShow = git('show', 'HEAD:AGENTS.md');
          if (headShow.status === 0) {
            const { block: headDocsBlock, hasBlock: headHasDocsBlock } = extractManagedDocsBlock(headShow.stdout);
            if (headHasDocsBlock && headDocsBlock.trim() === stagedDocsBlock.trim()) {
              docsMatches = true;
            }
          }
          if (!docsMatches) {
            try {
              const canonicalDocsBlock = buildDocsIndexBlock(repoRoot);
              if (canonicalDocsBlock.trim() === stagedDocsBlock.trim()) {
                docsMatches = true;
              }
            } catch {
              // ignore
            }
          }
          if (!docsMatches) {
            return {
              status: 1,
              stdout: '',
              stderr:
                'pre-commit: refusing commit with modified agent-rig documentation index in AGENTS.md.\n' +
                'The block between <!-- AGENT-RIG:DOCS:START --> and <!-- AGENT-RIG:DOCS:END --> is managed by agent-rig.\n' +
                "Run 'rig update' or 'rig check-docs --fix' to refresh it, or restore the block from HEAD.\n",
            };
          }
        }
      }

      for (const line of stagedLines) {
        const tabIdx = line.indexOf('\t');
        if (tabIdx === -1) continue;
        const status = line.slice(0, tabIdx).trim();
        if (status === 'D') continue;
        const stagedFile = line.slice(tabIdx + 1).trim().replace(/\\/g, '/');
        if (stagedFile !== 'AGENTS.md' && stagedFile.endsWith('README.md') && stagedFile.startsWith('docs/')) {
          const colShow = git('show', `:${stagedFile}`);
          if (colShow.status === 0) {
            const { block: stagedDocsBlock, hasBlock: stagedHasDocsBlock } = extractManagedDocsBlock(colShow.stdout);
            if (stagedHasDocsBlock) {
              let docsMatches = false;
              const headShow = git('show', `HEAD:${stagedFile}`);
              if (headShow.status === 0) {
                const { block: headDocsBlock, hasBlock: headHasDocsBlock } = extractManagedDocsBlock(headShow.stdout);
                if (headHasDocsBlock && headDocsBlock.trim() === stagedDocsBlock.trim()) {
                  docsMatches = true;
                }
              }
              if (!docsMatches) {
                try {
                  const colDir = path.dirname(path.join(repoRoot, stagedFile));
                  const canonicalDocsBlock = buildCollectionDocsIndexBlock(colDir, repoRoot);
                  if (canonicalDocsBlock.trim() === stagedDocsBlock.trim()) {
                    docsMatches = true;
                  }
                } catch {
                  // ignore
                }
              }
              if (!docsMatches) {
                return {
                  status: 1,
                  stdout: '',
                  stderr:
                    `pre-commit: refusing commit with modified agent-rig documentation index in ${stagedFile}.\n` +
                    'The block between <!-- AGENT-RIG:DOCS:START --> and <!-- AGENT-RIG:DOCS:END --> is managed by agent-rig.\n' +
                    "Run 'rig update' or 'rig check-docs --fix' to refresh it, or restore the block from HEAD.\n",
                };
              }
            }
          }
        }
      }
    }
  }

  const branchRes = git('symbolic-ref', '--short', '-q', 'HEAD');
  const branch = branchRes.status === 0 ? branchRes.stdout.trim() : '';

  if (gitDir === commonDir) {
    // In the main checkout, only merge commits onto main/master are allowed,
    // except for documentation, .rig/ assets, and legacy hook deletion commits.
    if ((branch === 'main' || branch === 'master') && existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
      return { status: 0, stdout: '', stderr: '' };
    }

    if (branch === 'main' || branch === 'master') {
      const hasFiles = stagedLines.length > 0;

      let hasDocFiles = false;
      const isAllowedDirectCommit =
        hasFiles &&
        stagedLines.every((line) => {
          const tabIdx = line.indexOf('\t');
          if (tabIdx === -1) return false;
          const status = line.slice(0, tabIdx).trim();
          const filePath = line.slice(tabIdx + 1).trim();
          const norm = filePath.replace(/\\/g, '/');

          if (norm === 'README.md' || norm === 'AGENTS.md' || norm.startsWith('docs/')) {
            hasDocFiles = true;
            return true;
          }
          if (norm.startsWith('.rig/')) {
            return true;
          }
          if (
            /^\.(gemini|claude|codex|cursor)\/(skills|agents|rules|hooks)\//.test(norm) ||
            norm === '.claude/settings.json'
          ) {
            return true;
          }
          if (status === 'D' && norm.startsWith('scripts/git-hooks/')) {
            return true;
          }
          return false;
        });

      if (isAllowedDirectCommit) {
        if (hasDocFiles) {
          const checkRes = runCheckDocs(repoRoot);
          if (checkRes.status !== 0) {
            return {
              status: checkRes.status ?? 1,
              stdout: checkRes.stdout || '',
              stderr: checkRes.stderr || '',
            };
          }
          const reflowRes = runReflowDocs(repoRoot, { check: true });
          if (reflowRes.status !== 0) {
            return {
              status: reflowRes.status ?? 1,
              stdout: reflowRes.stdout || '',
              stderr: reflowRes.stderr || '',
            };
          }
          return {
            status: 0,
            stdout: '',
            stderr: 'pre-commit: verifying doc links and formatting on main checkout...\n',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      }
    }

    return {
      status: 1,
      stdout: '',
      stderr:
        'pre-commit: refusing direct commit in the main checkout.\n' +
        'The main checkout only accepts merge commits, doc-only commits, or .rig/ asset commits on main/master.\n' +
        'Create or enter a linked git worktree first (e.g. git worktree add .worktrees/<slug> -b <type>/<slug>).\n',
    };
  }

  // In a linked worktree, main/master should never receive direct commits.
  if (branch === 'main' || branch === 'master') {
    return {
      status: 1,
      stdout: '',
      stderr:
        "pre-commit: refusing to commit on '" +
        branch +
        "' in a linked worktree.\n" +
        'main remains attached in the main checkout; merge feature branches from there via merge-to-main.\n',
    };
  }

  return { status: 0, stdout: '', stderr: '' };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'help';
  const force = args.includes('--force');

  if (cmd === 'install' || cmd === 'install-global') {
    const homeIdx = args.indexOf('--home');
    const homeDir = homeIdx !== -1 && args[homeIdx + 1] ? path.resolve(args[homeIdx + 1]) : homedir();
    const detectedOnly = args.includes('--detected');

    let harnesses = null;
    const hIdx = args.findIndex((a) => a === '--harnesses' || a.startsWith('--harnesses='));
    if (hIdx !== -1) {
      const raw = args[hIdx].includes('=') ? args[hIdx].split('=')[1] : args[hIdx + 1] ?? '';
      harnesses = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (!detectedOnly && process.stdin.isTTY) {
      const discovered = detectHarnesses(homeDir);
      harnesses = await promptForHarnesses(discovered);
    }

    const res = installRig({ homeDir, harnesses, detectedOnly, force });
    console.log(`rig install: configured [${res.installedHarnesses.join(', ')}]`);
    console.log(`  linked: ${res.linked.length}, updated configs: ${res.updated.length}, skipped: ${res.skipped.length}`);
    return;
  }

  if (cmd === 'update') {
    const homeIdx = args.indexOf('--home');
    const homeDir = homeIdx !== -1 && args[homeIdx + 1] ? path.resolve(args[homeIdx + 1]) : homedir();
    const repoIdx = args.indexOf('--repo');
    const repoDir = repoIdx !== -1 && args[repoIdx + 1] ? path.resolve(args[repoIdx + 1]) : null;
    const allRepos = args.includes('--all');
    const hIdx = args.findIndex((a) => a === '--harness' || a.startsWith('--harness='));
    const harness = hIdx !== -1 ? (args[hIdx].includes('=') ? args[hIdx].split('=')[1] : args[hIdx + 1]) : null;
    const res = updateRig({ homeDir, repoDir, allRepos, harness });
    console.log(`rig update: synced [${res.installedHarnesses.join(', ')}]`);
    console.log(`  new links: ${res.linked.length}, pruned dangling: ${res.pruned.length}, repos refreshed: ${res.updatedRepos.length}`);
    for (const w of res.warnings) {
      console.warn(w);
    }
    if (res.notice) {
      console.log(res.notice);
    }
    return;
  }

  if (cmd === 'profile') {
    const sub = args[1];
    if (!sub || sub === 'list') {
      const json = args.includes('--json');
      const list = listProfiles(RIG_ROOT);
      if (json) {
        console.log(JSON.stringify(list, null, 2));
      } else {
        console.log('Active profiles per harness:');
        for (const [h, p] of Object.entries(list.activeProfiles)) {
          console.log(`  ${h.padEnd(12)} -> ${p}`);
        }
        console.log('\nConfigured profiles:');
        for (const [pName, pData] of Object.entries(list.profiles)) {
          const mark = pData.isActive ? ' [active]' : '';
          console.log(`\n  Profile: ${pName} (${pData.harness})${mark}`);
          for (const [r, rData] of Object.entries(pData.roles)) {
            console.log(`    ${r.padEnd(10)} model: ${rData.model.padEnd(20)} subagentModel: ${rData.subagentModel.padEnd(12)} effort: ${rData.effort}`);
          }
        }
      }
      return;
    }
    if (sub === 'use') {
      const pName = args[2];
      if (!pName) {
        console.error('Error: specify profile name: rig profile use <profile-name>');
        process.exit(1);
      }
      const res = useProfile(pName, { rigRoot: RIG_ROOT, homeDir: homedir() });
      console.log(`Activated profile '${res.profileName}' for harness '${res.harness}' and re-hydrated installed harnesses.`);
      return;
    }
    if (sub === 'set') {
      const role = args[2];
      const model = args[3];
      if (!role || !model) {
        console.error('Error: usage: rig profile set <role> <model> [--effort <level>] [--subagent-model <selector>] [--profile <name>] [--harness <id>]');
        process.exit(1);
      }
      const effortIdx = args.indexOf('--effort');
      const effort = effortIdx !== -1 ? args[effortIdx + 1] : null;
      const subIdx = args.indexOf('--subagent-model');
      const subagentModel = subIdx !== -1 ? args[subIdx + 1] : null;
      const profIdx = args.indexOf('--profile');
      const profileName = profIdx !== -1 ? args[profIdx + 1] : null;
      const hIdx = args.indexOf('--harness');
      const harness = hIdx !== -1 ? args[hIdx + 1] : null;

      const res = setProfileRole(role, model, { effort, subagentModel, profileName, harness, rigRoot: RIG_ROOT, homeDir: homedir() });
      console.log(`Updated role '${res.role}' in profile '${res.profileName}' (${res.harness}): model=${res.model}, subagentModel=${res.subagentModel}, effort=${res.effort}. Re-hydrated harnesses.`);
      return;
    }
    console.error(`Unknown profile subcommand: ${sub}. Usage: rig profile [list] | rig profile use <name> | rig profile set <role> <model> [...]`);
    process.exit(1);
  }

  if (cmd === 'model') {
    const sub = args[1];
    if (sub === 'resolve') {
      const role = args[2];
      if (!role) {
        console.error('Error: specify role: rig model resolve <role> [--harness <id>] [--profile <name>] [--json]');
        process.exit(1);
      }
      const json = args.includes('--json');
      const hIdx = args.indexOf('--harness');
      const harness = hIdx !== -1 ? args[hIdx + 1] : null;
      const pIdx = args.indexOf('--profile');
      const profileName = pIdx !== -1 ? args[pIdx + 1] : null;

      const res = resolveRoleModel(role, { harness, profileName, rigRoot: RIG_ROOT });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`[${res.harness} / ${res.profile}] ${res.role}: model=${res.model}, subagentModel=${res.subagentModel}, effort=${res.effort}`);
      }
      return;
    }
    console.error(`Unknown model subcommand: ${sub}. Usage: rig model resolve <role> [--harness <id>] [--profile <name>] [--json]`);
    process.exit(1);
  }

  if (cmd === 'init') {
    const pos = args.slice(1).find((a) => !a.startsWith('-')) ?? process.cwd();
    const selfContained = args.includes('--self-contained');
    const stealth = args.includes('--stealth');
    const worktrees = !args.includes('--no-worktrees');
    const ui = args.includes('--ui');
    const hIdx = args.findIndex((a) => a === '--harness' || a.startsWith('--harness='));
    const harness = hIdx !== -1 ? (args[hIdx].includes('=') ? args[hIdx].split('=')[1] : args[hIdx + 1]) : null;
    const homeIdx = args.indexOf('--home');
    const homeDir = homeIdx !== -1 && args[homeIdx + 1] ? path.resolve(args[homeIdx + 1]) : homedir();
    const res = initRepo(pos, { selfContained, worktrees, ui, force, homeDir, harness, stealth });
    if (res.delegatedToAttach) {
      console.log(
        `rig init (${res.dir}): already rigged; attached repo (hooksConfigured=${res.hooksConfigured}, mainCheckout=${res.mainCheckoutHead.status})`,
      );
      if (res.hookWarning) {
        console.warn(`  warning: ${res.hookWarning.split('\n').join('\n  ')}`);
      } else if (!res.hooksConfigured) {
        console.warn('  warning: could not set git config core.hooksPath=.rig/hooks; set it by hand.');
      }
      return;
    }
    console.log(
      `rig init (${res.dir}): copied ${res.copied.length}, merged ${res.merged.length}, skipped ${res.skipped.length}, staged ${res.staged.length}`,
    );
    if (res.hookWarning) {
      console.warn(`  warning: ${res.hookWarning.split('\n').join('\n  ')}`);
    } else if (worktrees && !res.hooksConfigured) {
      console.warn('  warning: could not set git config core.hooksPath=.rig/hooks; set it by hand.');
    }
    if (res.initWorktree) {
      console.log(
        `  scaffolded in linked worktree ${res.initWorktree.path} on ${res.initWorktree.branch} (the main checkout only accepts merge commits).`,
      );
      console.log(`  next: review, git -C ${res.initWorktree.path} commit, then merge via skills/merge-to-main/SKILL.md.`);
    } else if (worktrees && res.mainCheckoutHead.status === 'no-commits') {
      console.log('  note: the repository has no commits yet.');
      console.log('  next: git commit -m "chore: initial commit" (allowed on an unborn repo), then work in linked worktrees.');
    }
    return;
  }

  if (cmd === 'attach') {
    const pos = args.slice(1).find((a) => !a.startsWith('-')) ?? process.cwd();
    const homeIdx = args.indexOf('--home');
    const homeDir = homeIdx !== -1 && args[homeIdx + 1] ? path.resolve(args[homeIdx + 1]) : homedir();
    const res = attachRepo(pos, { homeDir, force });
    console.log(`rig attach (${res.dir}): hooksConfigured=${res.hooksConfigured}, mainCheckout=${res.mainCheckoutHead.status}`);
    if (res.hookWarning) {
      console.warn(`  warning: ${res.hookWarning.split('\n').join('\n  ')}`);
    } else if (!res.hooksConfigured) {
      console.warn('  warning: could not set git config core.hooksPath=.rig/hooks; set it by hand.');
    }
    return;
  }

  if (cmd === 'eject') {
    const homeIdx = args.indexOf('--home');
    const homeDir = homeIdx !== -1 && args[homeIdx + 1] ? path.resolve(args[homeIdx + 1]) : homedir();
    const pos = args.slice(1).find((a, i) => !a.startsWith('-') && (homeIdx === -1 || i + 1 !== homeIdx + 1)) ?? process.cwd();
    const res = ejectRepo(pos, { homeDir });
    console.log(`rig eject (${res.dir}): hooksUnset=${res.hooksUnset}, removedPaths=${res.removedPaths.length}, stateRemoved=${res.stateRemoved}`);
    return;
  }

  if (cmd === 'hook') {
    const sub = args[1];
    if (sub === 'pre-commit') {
      const pos = args.slice(2).find((a) => !a.startsWith('-')) ?? process.cwd();
      const res = runPreCommitHook(pos);
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exit(res.status ?? 0);
    }
    console.error(`Unknown hook subcommand: ${sub}. Usage: rig hook pre-commit [<target-dir>]`);
    process.exit(1);
  }

  if (cmd === 'check-docs') {
    const pos = args.slice(1).find((a) => !a.startsWith('-')) ?? process.cwd();
    const fix = args.includes('--fix');
    const res = runCheckDocs(pos, { fix });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    process.exit(res.status ?? 1);
  }

  if (cmd === 'reflow-docs') {
    const pos = args.slice(1).find((a) => !a.startsWith('-')) ?? process.cwd();
    const check = args.includes('--check');
    const res = runReflowDocs(pos, { check });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    process.exit(res.status ?? 1);
  }

  if (cmd === 'status') {
    const pos = args.slice(1).find((a) => !a.startsWith('-')) ?? process.cwd();
    console.log(JSON.stringify(statusRepo(pos), null, 2));
    return;
  }

  console.log(`Usage:
  rig install [--harnesses antigravity,claude,codex,cursor] [--detected] [--force]
  rig update [--all] [--repo <target-dir>] [--home <dir>] [--harness <id>]
  rig profile [list] [--json]
  rig profile use <profile-name>
  rig profile set <role> <model> [--effort <low|medium|high|max>] [--subagent-model <selector>] [--profile <name>] [--harness <id>]
  rig model resolve <role> [--harness <id>] [--profile <name>] [--json]
  rig init [<target-dir>] [--self-contained] [--stealth] [--no-worktrees] [--ui] [--force] [--harness <id>]
  rig attach [<target-dir>] [--home <dir>] [--force]
  rig eject [<target-dir>] [--home <dir>]
  rig hook pre-commit [<target-dir>]
  rig check-docs [<target-dir>] [--fix]
  rig reflow-docs [<target-dir>] [--check]
  rig status [<target-dir>]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
