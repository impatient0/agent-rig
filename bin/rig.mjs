#!/usr/bin/env node
// CLI for agent-rig:
//   rig install [--harnesses antigravity,claude,...] [--detected] [--home <dir>] [--force]
//   rig update [--home <dir>] [--repo <dir>]
//   rig profile [list] [--json]
//   rig profile use <profile-name>
//   rig profile set <role> <model> [--effort <low|medium|high|max>] [--subagent-model <selector>] [--profile <name>] [--harness <id>]
//   rig model resolve <role> [--harness <id>] [--profile <name>] [--json]
//   rig init [<target-dir>] [--self-contained] [--no-worktrees] [--ui] [--force]
//   rig detach [<target-dir>]
//   rig check-docs [<target-dir>]
//   rig reflow-docs [<target-dir>] [--check]
//   rig status [<target-dir>]

import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
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
  return path.join(rigRoot, '.rig.local.json');
}

export function ensureRigConfig(rigRoot = RIG_ROOT) {
  const p = configFilePath(rigRoot);
  if (!existsSync(p)) {
    const template = path.join(rigRoot, 'templates', 'rig-config.default.json');
    if (existsSync(template)) {
      mkdirSync(path.dirname(p), { recursive: true });
      copyFileSync(template, p);
    }
  }
  return p;
}

export function loadRigConfig(rigRoot = RIG_ROOT) {
  ensureRigConfig(rigRoot);
  const p = configFilePath(rigRoot);
  if (!existsSync(p)) return { activeProfiles: {}, profiles: {} };
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { activeProfiles: {}, profiles: {} };
  }
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

export function writeHydratedFile(srcPath, destPath, resolvedProfile, { executable = false } = {}) {
  const template = readFileSync(srcPath, 'utf8');
  const hydrated = hydrateText(template, resolvedProfile);
  mkdirSync(path.dirname(destPath), { recursive: true });
  if (isSymlink(destPath)) rmSync(destPath, { force: true });
  writeFileSync(destPath, hydrated, 'utf8');
  if (executable) chmodSync(destPath, 0o755);
}

export function copyOrHydrateDir(srcDir, destDir, resolvedProfile, { hydrated = [] } = {}) {
  if (isSymlink(destDir)) rmSync(destDir, { force: true });
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcEntry = path.join(srcDir, entry);
    const destEntry = path.join(destDir, entry);
    const stat = lstatSync(srcEntry);
    if (stat.isDirectory()) {
      copyOrHydrateDir(srcEntry, destEntry, resolvedProfile, { hydrated });
    } else if (stat.isFile()) {
      if (srcEntry.endsWith('.md')) {
        writeHydratedFile(srcEntry, destEntry, resolvedProfile);
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
  if (!existsSync(p)) return { installedHarnesses: [], initializedRepos: [], installedSkills: [] };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return {
      installedHarnesses: Array.isArray(raw.installedHarnesses) ? raw.installedHarnesses : [],
      initializedRepos: Array.isArray(raw.initializedRepos) ? raw.initializedRepos : [],
      installedSkills: Array.isArray(raw.installedSkills) ? raw.installedSkills : [],
    };
  } catch {
    return { installedHarnesses: [], initializedRepos: [], installedSkills: [] };
  }
}

export function writeRigState(homeDir, patch) {
  const current = readRigState(homeDir);
  const next = {
    installedHarnesses: patch.installedHarnesses
      ? [...new Set([...current.installedHarnesses, ...patch.installedHarnesses])]
      : current.installedHarnesses,
    initializedRepos: patch.initializedRepos
      ? [...new Set([...current.initializedRepos, ...patch.initializedRepos])]
      : current.initializedRepos,
    installedSkills: patch.installedSkills
      ? [...new Set([...current.installedSkills, ...patch.installedSkills])]
      : current.installedSkills,
  };
  const p = stateFilePath(homeDir);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

function copyFileSafe(src, dest, { force = false, copied = [], skipped = [], executable = false } = {}) {
  if ((existsSync(dest) || isSymlink(dest)) && !force) {
    skipped.push(dest);
    return false;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  if (isSymlink(dest)) rmSync(dest, { force: true });
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

function pruneDanglingRigSymlinks(dir, pruned = []) {
  if (!existsSync(dir)) return pruned;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!isSymlink(full)) continue;
    const target = path.resolve(dir, readlinkSync(full));
    if (target.startsWith(RIG_ROOT) && !existsSync(target)) {
      rmSync(full, { force: true });
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
        rmSync(full, { force: true });
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

function linkSafe(src, dest, { force = false, linked = [], skipped = [] } = {}) {
  if (existsSync(dest) || isSymlink(dest)) {
    if (!force) {
      skipped.push(dest);
      return false;
    }
    rmSync(dest, { force: true });
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  symlinkSync(src, dest);
  linked.push(dest);
  return true;
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
        const already = existingGroup.hooks.some(
          (h) => h.type === inHook.type && h.command === inHook.command,
        );
        if (!already) {
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

function installForAntigravity(homeDir, { force = false, hydrated = [], linked = [], skipped = [], updated = [], pruned = [], rigRoot = RIG_ROOT }) {
  const configDir = path.join(homeDir, '.gemini', 'config');
  const pluginsDir = path.join(configDir, 'plugins');
  const pluginDir = path.join(pluginsDir, 'agent-rig');
  mkdirSync(pluginsDir, { recursive: true });

  if (isSymlink(pluginDir)) {
    rmSync(pluginDir, { force: true });
  }
  mkdirSync(pluginDir, { recursive: true });

  const resolvedProfile = resolveProfile('antigravity', { rigRoot });

  copyFileSafe(path.join(rigRoot, 'plugin.json'), path.join(pluginDir, 'plugin.json'), { force: true, copied: updated });
  copyFileSafe(path.join(rigRoot, 'hooks.json'), path.join(pluginDir, 'hooks.json'), { force: true, copied: updated });

  linkSafe(path.join(rigRoot, 'hooks'), path.join(pluginDir, 'hooks'), { force: true, linked, skipped });

  const rulesSrcDir = path.join(rigRoot, 'rules');
  const rulesDestDir = path.join(pluginDir, 'rules');
  mkdirSync(rulesDestDir, { recursive: true });
  for (const rule of readdirSync(rulesSrcDir)) {
    const src = path.join(rulesSrcDir, rule);
    const dest = path.join(rulesDestDir, rule);
    if (rule.endsWith('.md')) {
      writeHydratedFile(src, dest, resolvedProfile);
      hydrated.push(dest);
    } else {
      copyFileSafe(src, dest, { force: true, copied: hydrated });
    }
  }

  const skillsSrcDir = path.join(rigRoot, 'skills');
  const skillsDestDir = path.join(pluginDir, 'skills');
  mkdirSync(skillsDestDir, { recursive: true });
  const rigSkills = readdirSync(skillsSrcDir);
  for (const skill of rigSkills) {
    copyOrHydrateDir(path.join(skillsSrcDir, skill), path.join(skillsDestDir, skill), resolvedProfile, { hydrated });
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
        writeHydratedFile(src, dest, resolvedProfile);
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

function installForClaude(homeDir, { force = false, hydrated = [], linked = [], skipped = [], updated = [], pruned = [], rigRoot = RIG_ROOT, obsoleteSkills = [] }) {
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
    copyOrHydrateDir(path.join(skillsDir, skill), path.join(claudeDir, 'skills', skill), resolvedProfile, { hydrated });
  }

  const agentsDir = path.join(rigRoot, 'agents');
  if (existsSync(agentsDir)) {
    for (const agent of readdirSync(agentsDir)) {
      const src = path.join(agentsDir, agent);
      const dest = path.join(claudeDir, 'agents', agent);
      if (agent.endsWith('.md')) {
        writeHydratedFile(src, dest, resolvedProfile);
        hydrated.push(dest);
      } else {
        copyFileSafe(src, dest, { force: true, copied: hydrated });
      }
    }
  }

  for (const rule of ['AGENTS.md', 'ui-change-gate.md']) {
    const src = path.join(rigRoot, 'rules', rule);
    const dest = path.join(claudeDir, 'rules', rule);
    if (existsSync(src)) {
      writeHydratedFile(src, dest, resolvedProfile);
      hydrated.push(dest);
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
            { type: 'command', command: `node "${path.join(claudeDir, 'hooks/guard-remote-mutation.mjs')}" --harness=claude` },
            { type: 'command', command: `node "${path.join(claudeDir, 'hooks/guard-symlinked-node-modules.mjs')}" --harness=claude` },
          ],
        },
        {
          matcher: 'Edit|Write',
          hooks: [
            { type: 'command', command: `node "${path.join(claudeDir, 'hooks/guard-main-checkout-edits.mjs')}" --harness=claude` },
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
    copyOrHydrateDir(path.join(skillsDir, skill), path.join(codexDir, 'skills', skill), resolvedProfile, { hydrated });
  }
  writeHydratedFile(path.join(rigRoot, 'rules/AGENTS.md'), path.join(codexDir, 'AGENTS.md'), resolvedProfile);
  hydrated.push(path.join(codexDir, 'AGENTS.md'));
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
    copyOrHydrateDir(path.join(skillsDir, skill), path.join(cursorDir, 'skills', skill), resolvedProfile, { hydrated });
  }
  writeHydratedFile(path.join(rigRoot, 'rules/AGENTS.md'), path.join(cursorDir, 'rules/AGENTS.md'), resolvedProfile);
  hydrated.push(path.join(cursorDir, 'rules/AGENTS.md'));
}

export function installRig({
  homeDir = homedir(),
  harnesses = null,
  detectedOnly = false,
  force = false,
  rigRoot = RIG_ROOT,
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
  const currentSkills = existsSync(path.join(rigRoot, 'skills')) ? readdirSync(path.join(rigRoot, 'skills')) : [];
  const obsoleteSkills = (state.installedSkills || []).filter((s) => !currentSkills.includes(s));

  const hydrated = [];
  const linked = [];
  const skipped = [];
  const updated = [];
  const pruned = [];

  const localBinDir = path.join(homeDir, '.local', 'bin');
  mkdirSync(localBinDir, { recursive: true });
  pruneDanglingRigSymlinks(localBinDir, pruned);
  const localBinRig = path.join(localBinDir, 'rig');
  linkSafe(path.join(rigRoot, 'bin/rig.mjs'), localBinRig, { force, linked, skipped });

  for (const id of selectedIds) {
    if (id === 'antigravity') installForAntigravity(homeDir, { force, hydrated, linked, skipped, updated, pruned, rigRoot });
    else if (id === 'claude') installForClaude(homeDir, { force, hydrated, linked, skipped, updated, pruned, rigRoot, obsoleteSkills });
    else if (id === 'codex') installForCodex(homeDir, { force, hydrated, skipped, pruned, rigRoot, obsoleteSkills });
    else if (id === 'cursor') installForCursor(homeDir, { force, hydrated, skipped, pruned, rigRoot, obsoleteSkills });
    else throw new Error(`Unknown harness id: ${id}`);
  }

  writeRigState(homeDir, { installedHarnesses: selectedIds, installedSkills: currentSkills });

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

export function updateRepo(targetDir) {
  const dir = path.resolve(targetDir);
  const copied = [];
  const skipped = [];

  if (existsSync(path.join(dir, 'scripts/git-hooks'))) {
    copyFileSafe(path.join(RIG_ROOT, 'scripts/git-hooks/pre-commit'), path.join(dir, 'scripts/git-hooks/pre-commit'), {
      force: true,
      copied,
      skipped,
      executable: true,
    });
    copyFileSafe(
      path.join(RIG_ROOT, 'scripts/git-hooks/pre-merge-commit'),
      path.join(dir, 'scripts/git-hooks/pre-merge-commit'),
      { force: true, copied, skipped, executable: true },
    );
  }

  // If the repo was initialized with --self-contained, refresh static rig assets without touching AGENTS.md or docs/
  if (existsSync(path.join(dir, 'skills')) && existsSync(path.join(dir, 'rules/AGENTS.md'))) {
    const resolvedProfile = resolveProfile('claude', { rigRoot: RIG_ROOT });
    const skillsDir = path.join(RIG_ROOT, 'skills');
    for (const skill of readdirSync(skillsDir)) {
      copyOrHydrateDir(path.join(skillsDir, skill), path.join(dir, 'skills', skill), resolvedProfile, { hydrated: copied });
    }
    if (existsSync(path.join(RIG_ROOT, 'agents'))) {
      for (const agent of readdirSync(path.join(RIG_ROOT, 'agents'))) {
        const src = path.join(RIG_ROOT, 'agents', agent);
        const dest = path.join(dir, 'agents', agent);
        if (agent.endsWith('.md')) {
          writeHydratedFile(src, dest, resolvedProfile);
          copied.push(dest);
        } else {
          copyFileSafe(src, dest, { force: true, copied, skipped });
        }
      }
    }
    writeHydratedFile(path.join(RIG_ROOT, 'rules/AGENTS.md'), path.join(dir, 'rules/AGENTS.md'), resolvedProfile);
    copied.push(path.join(dir, 'rules/AGENTS.md'));
    writeHydratedFile(path.join(RIG_ROOT, 'rules/ui-change-gate.md'), path.join(dir, 'rules/ui-change-gate.md'), resolvedProfile);
    copied.push(path.join(dir, 'rules/ui-change-gate.md'));
    copyFileSafe(path.join(RIG_ROOT, 'scripts/check-doc-links.mjs'), path.join(dir, 'scripts/check-doc-links.mjs'), {
      force: true,
      copied,
      skipped,
      executable: true,
    });
    copyFileSafe(path.join(RIG_ROOT, 'scripts/reflow-docs.mjs'), path.join(dir, 'scripts/reflow-docs.mjs'), {
      force: true,
      copied,
      skipped,
      executable: true,
    });
    if (existsSync(path.join(dir, 'hooks'))) {
      copyFileSafe(path.join(RIG_ROOT, 'hooks/lib/hook-io.mjs'), path.join(dir, 'hooks/lib/hook-io.mjs'), {
        force: true,
        copied,
        skipped,
      });
      for (const hf of ['guard-remote-mutation.mjs', 'guard-main-checkout-edits.mjs', 'guard-symlinked-node-modules.mjs']) {
        if (existsSync(path.join(dir, 'hooks', hf))) {
          copyFileSafe(path.join(RIG_ROOT, 'hooks', hf), path.join(dir, 'hooks', hf), {
            force: true,
            copied,
            skipped,
            executable: true,
          });
        }
      }
    }
  }

  return { dir, copied };
}

export function updateRig({ homeDir = homedir(), repoDir = null, rigRoot = RIG_ROOT } = {}) {
  const state = readRigState(homeDir);
  const harnesses =
    state.installedHarnesses.length > 0
      ? state.installedHarnesses
      : detectHarnesses(homeDir)
          .filter((d) => d.detected)
          .map((d) => d.id);

  const globalRes = installRig({ homeDir, harnesses, force: false, rigRoot });

  const reposToUpdate = [];
  if (repoDir) {
    reposToUpdate.push(path.resolve(repoDir));
  } else {
    for (const r of state.initializedRepos) {
      if (existsSync(r)) reposToUpdate.push(r);
    }
  }

  const updatedRepos = reposToUpdate.map((r) => updateRepo(r));

  return {
    ...globalRes,
    updatedRepos,
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

export function detachMainCheckout(targetDir, { reanchorToMain = false } = {}) {
  const dir = path.resolve(targetDir);
  if (!existsSync(path.join(dir, '.git'))) {
    return { detached: false, status: 'not-a-git-repo' };
  }
  const hasHead = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD'], { encoding: 'utf8' });
  if (hasHead.status !== 0) {
    return { detached: false, status: 'no-commits' };
  }
  const branchRes = spawnSync('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8' });
  const currentBranch = branchRes.status === 0 ? branchRes.stdout.trim() : null;

  // Untracked files never block `git switch --detach`, so only tracked changes count as dirty here;
  // otherwise freshly scaffolded rig files would keep the main checkout attached to `main`.
  const statusRes = spawnSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  if (statusRes.stdout.trim().length > 0) {
    return { detached: false, status: 'dirty', previousBranch: currentBranch };
  }

  if (!currentBranch && !reanchorToMain) {
    return { detached: true, status: 'already-detached' };
  }

  const targetRef = reanchorToMain ? 'main' : 'HEAD';
  const sw = spawnSync('git', ['-C', dir, 'switch', '--detach', targetRef], { encoding: 'utf8' });
  if (sw.status !== 0) {
    const fallback = spawnSync('git', ['-C', dir, 'switch', '--detach'], { encoding: 'utf8' });
    if (fallback.status !== 0) {
      return { detached: false, status: 'switch-failed', error: fallback.stderr };
    }
  }
  return { detached: true, status: 'detached', previousBranch: currentBranch };
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

export function initRepo(
  targetDir,
  { selfContained = false, worktrees = true, ui = false, force = false, homeDir = null } = {},
) {
  const requestedDir = path.resolve(targetDir);
  mkdirSync(requestedDir, { recursive: true });

  const where = worktreeInfo(requestedDir);
  let initWorktree = null;
  if (worktrees && where.isRepo && !where.isLinked && where.hasCommits) {
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

  if (!existsSync(path.join(dir, 'README.md'))) {
    writeFileSync(
      path.join(dir, 'README.md'),
      '# ' + path.basename(dir) + '\n\nSee [AGENTS.md](AGENTS.md) and [docs/backlog.md](docs/backlog.md).\n',
      'utf8',
    );
    copied.push(path.join(dir, 'README.md'));
  }

  if (ui) {
    copyFileSafe(
      path.join(RIG_ROOT, 'templates/docs/design/mockup-scaffold.html'),
      path.join(dir, 'docs/design/mockup-scaffold.html'),
      { force, copied, skipped },
    );
  }

  let hooksConfigured = false;
  if (worktrees) {
    copyFileSafe(path.join(RIG_ROOT, 'scripts/git-hooks/pre-commit'), path.join(dir, 'scripts/git-hooks/pre-commit'), {
      force,
      copied,
      skipped,
      executable: true,
    });
    copyFileSafe(
      path.join(RIG_ROOT, 'scripts/git-hooks/pre-merge-commit'),
      path.join(dir, 'scripts/git-hooks/pre-merge-commit'),
      { force, copied, skipped, executable: true },
    );
    if (existsSync(path.join(dir, '.git'))) {
      const cfg = spawnSync('git', ['-C', dir, 'config', 'core.hooksPath', 'scripts/git-hooks']);
      hooksConfigured = cfg.status === 0;
    }

    const gitignorePath = path.join(dir, '.gitignore');
    const before = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    const normalized = normalizeGitignore(before);
    if (normalized.changed) {
      writeFileSync(gitignorePath, normalized.content, 'utf8');
      merged.push(gitignorePath);
    }
  }

  if (selfContained) {
    const resolvedProfile = resolveProfile('claude', { rigRoot: RIG_ROOT });
    const skillsDir = path.join(RIG_ROOT, 'skills');
    for (const skill of readdirSync(skillsDir)) {
      copyOrHydrateDir(path.join(skillsDir, skill), path.join(dir, 'skills', skill), resolvedProfile, { hydrated: copied });
    }
    const agentsDir = path.join(RIG_ROOT, 'agents');
    if (existsSync(agentsDir)) {
      for (const agent of readdirSync(agentsDir)) {
        const src = path.join(agentsDir, agent);
        const dest = path.join(dir, 'agents', agent);
        if (agent.endsWith('.md')) {
          writeHydratedFile(src, dest, resolvedProfile);
          copied.push(dest);
        } else {
          copyFileSafe(src, dest, { force: true, copied, skipped });
        }
      }
    }
    writeHydratedFile(path.join(RIG_ROOT, 'rules/AGENTS.md'), path.join(dir, 'rules/AGENTS.md'), resolvedProfile);
    copied.push(path.join(dir, 'rules/AGENTS.md'));
    writeHydratedFile(path.join(RIG_ROOT, 'rules/ui-change-gate.md'), path.join(dir, 'rules/ui-change-gate.md'), resolvedProfile);
    copied.push(path.join(dir, 'rules/ui-change-gate.md'));
    copyFileSafe(path.join(RIG_ROOT, 'scripts/check-doc-links.mjs'), path.join(dir, 'scripts/check-doc-links.mjs'), {
      force,
      copied,
      skipped,
      executable: true,
    });
    copyFileSafe(path.join(RIG_ROOT, 'scripts/reflow-docs.mjs'), path.join(dir, 'scripts/reflow-docs.mjs'), {
      force,
      copied,
      skipped,
      executable: true,
    });

    copyFileSafe(path.join(RIG_ROOT, 'hooks/lib/hook-io.mjs'), path.join(dir, 'hooks/lib/hook-io.mjs'), {
      force,
      copied,
      skipped,
    });
    copyFileSafe(path.join(RIG_ROOT, 'hooks/lib/hook-io.mjs'), path.join(dir, '.claude/hooks/lib/hook-io.mjs'), {
      force,
      copied,
      skipped,
    });
    const hookFiles = worktrees
      ? ['guard-remote-mutation.mjs', 'guard-main-checkout-edits.mjs', 'guard-symlinked-node-modules.mjs']
      : ['guard-remote-mutation.mjs'];
    for (const hf of hookFiles) {
      copyFileSafe(path.join(RIG_ROOT, 'hooks', hf), path.join(dir, 'hooks', hf), {
        force,
        copied,
        skipped,
        executable: true,
      });
      copyFileSafe(path.join(RIG_ROOT, 'hooks', hf), path.join(dir, '.claude/hooks', hf), {
        force,
        copied,
        skipped,
        executable: true,
      });
    }

    const templateSettings = JSON.parse(
      readFileSync(
        path.join(RIG_ROOT, worktrees ? 'templates/claude/settings.worktree.json' : 'templates/claude/settings.minimal.json'),
        'utf8',
      ),
    );
    const settingsDest = path.join(dir, '.claude/settings.json');
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

    const selfAgentsMd = [
      '# Project Context',
      '',
      "Describe the project's purpose, primary stack, and architecture here.",
      '',
      '- **Test and verification gate** — npm test',
      '- **Architecture decisions** — [ADR 0001](docs/adr/0001-record-architecture-decisions.md)',
      '- **Active backlog** — [docs/backlog.md](docs/backlog.md)',
      '- **Universal Engineering Rules** — [rules/AGENTS.md](rules/AGENTS.md)',
      '- **Human-in-the-Loop UI Gate** — [rules/ui-change-gate.md](rules/ui-change-gate.md)',
      '- **Cold Verifier Subagent** — [agents/verifier.md](agents/verifier.md)',
      '',
    ].join('\n');
    const agentsDest = path.join(dir, 'AGENTS.md');
    if (!existsSync(agentsDest) || force) {
      writeFileSync(agentsDest, selfAgentsMd, 'utf8');
      copied.push(agentsDest);
    } else {
      skipped.push(agentsDest);
    }
  } else {
    copyFileSafe(path.join(RIG_ROOT, 'templates/AGENTS.md'), path.join(dir, 'AGENTS.md'), {
      force,
      copied,
      skipped,
    });
  }

  const mainCheckout = where.isRepo ? where.mainCheckout : requestedDir;
  if (homeDir) {
    writeRigState(homeDir, { initializedRepos: [mainCheckout] });
  }

  // Stage what rig init wrote, so `rig check-docs` (which only trusts tracked files) passes at once
  // and the next step is a plain `git commit`. Nothing is committed here.
  let staged = [];
  if (where.isRepo) {
    staged = [...copied, ...merged]
      .map((p) => path.relative(dir, p))
      .filter((p) => p && !p.startsWith('..'));
    if (staged.length > 0) {
      const add = spawnSync('git', ['-C', dir, 'add', '--', ...staged], { encoding: 'utf8' });
      if (add.status !== 0) staged = [];
    }
  }

  const worktreeHead = worktrees && where.isRepo
    ? detachMainCheckout(mainCheckout, { reanchorToMain: false })
    : { detached: false, status: worktrees ? 'not-a-git-repo' : 'skipped' };

  return {
    dir,
    copied,
    skipped,
    merged,
    staged,
    hooksConfigured,
    worktreeHead,
    initWorktree,
    hasCommits: where.hasCommits,
  };
}

export function statusRepo(targetDir = process.cwd()) {
  const dir = path.resolve(targetDir);
  const skillsDir = existsSync(path.join(dir, 'skills'))
    ? path.join(dir, 'skills')
    : path.join(dir, '.claude/skills');
  const skillsPresent = existsSync(skillsDir) ? readdirSync(skillsDir) : [];

  const hooksDir = existsSync(path.join(dir, 'hooks'))
    ? path.join(dir, 'hooks')
    : path.join(dir, '.claude/hooks');
  const hooksPresent = existsSync(hooksDir)
    ? readdirSync(hooksDir).filter((f) => f.startsWith('guard-'))
    : [];

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
  };
}

export function runCheckDocs(targetDir = process.cwd()) {
  const script = path.join(RIG_ROOT, 'scripts/check-doc-links.mjs');
  return spawnSync(process.execPath, [script, path.resolve(targetDir)], { encoding: 'utf8' });
}

export function runReflowDocs(targetDir = process.cwd(), { check = false } = {}) {
  const script = path.join(RIG_ROOT, 'scripts/reflow-docs.mjs');
  const args = [script, path.resolve(targetDir)];
  if (check) args.push('--check');
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
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
    const res = updateRig({ homeDir, repoDir });
    console.log(`rig update: synced [${res.installedHarnesses.join(', ')}]`);
    console.log(`  new links: ${res.linked.length}, pruned dangling: ${res.pruned.length}, repos refreshed: ${res.updatedRepos.length}`);
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
    const worktrees = !args.includes('--no-worktrees');
    const ui = args.includes('--ui');
    const res = initRepo(pos, { selfContained, worktrees, ui, force, homeDir: homedir() });
    console.log(
      `rig init (${res.dir}): copied ${res.copied.length}, merged ${res.merged.length}, skipped ${res.skipped.length}, staged ${res.staged.length}`,
    );
    if (worktrees && !res.hooksConfigured) {
      console.warn('  warning: could not set git config core.hooksPath=scripts/git-hooks; set it by hand.');
    }
    if (res.initWorktree) {
      console.log(
        `  scaffolded in linked worktree ${res.initWorktree.path} on ${res.initWorktree.branch} (the main checkout refuses commits).`,
      );
      console.log(`  next: review, git -C ${res.initWorktree.path} commit, then merge via skills/merge-to-main/SKILL.md.`);
    } else if (worktrees && res.worktreeHead.status === 'no-commits') {
      console.log('  note: the repository has no commits yet, so the main checkout cannot be parked.');
      console.log('  next: git commit --no-verify -m "chore: initial commit" (the one commit allowed on main), then rig detach.');
    }
    if (res.worktreeHead.status === 'dirty') {
      console.log('  note: the main checkout has uncommitted tracked changes; commit or stash them, then run "rig detach".');
    }
    return;
  }

  if (cmd === 'detach') {
    const pos = args.slice(1).find((a) => !a.startsWith('-')) ?? process.cwd();
    const res = detachMainCheckout(pos, { reanchorToMain: true });
    console.log(`rig detach: ${res.status}`);
    if (!res.detached && res.status === 'dirty') process.exit(1);
    return;
  }

  if (cmd === 'check-docs') {
    const pos = args.slice(1).find((a) => !a.startsWith('-')) ?? process.cwd();
    const res = runCheckDocs(pos);
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
  rig update [--repo <target-dir>]
  rig profile [list] [--json]
  rig profile use <profile-name>
  rig profile set <role> <model> [--effort <low|medium|high|max>] [--subagent-model <selector>] [--profile <name>] [--harness <id>]
  rig model resolve <role> [--harness <id>] [--profile <name>] [--json]
  rig init [<target-dir>] [--self-contained] [--no-worktrees] [--ui] [--force]
  rig detach [<target-dir>]
  rig check-docs [<target-dir>]
  rig reflow-docs [<target-dir>] [--check]
  rig status [<target-dir>]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
