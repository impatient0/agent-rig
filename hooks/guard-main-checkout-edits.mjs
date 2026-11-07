#!/usr/bin/env node
// PreToolUse file-edit guard (`edit_file`/`write_file` in Antigravity,
// `Edit`/`Write` in Claude Code): refuses file edits in the main checkout so
// parallel sessions never share a working copy.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHookInput, emitDecision } from './lib/hook-io.mjs';

export function existingAncestor(targetPath, cwd = process.cwd()) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return null;
  const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
  let dir = abs;
  try {
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      dir = path.dirname(abs);
    }
  } catch {
    dir = path.dirname(abs);
  }
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return dir;
}

function buildRemediation(harness) {
  if (harness === 'claude') {
    return (
      'Main checkout is read-only for code by convention (see AGENTS.md). ' +
      'Call EnterWorktree first (or spawn a subagent with isolation: "worktree"), ' +
      'rename the branch to <type>/<slug>, and symlink node_modules if present.'
    );
  }
  return (
    'Main checkout is read-only for code by convention (see AGENTS.md). ' +
    'Create a linked git worktree first (e.g. `git worktree add .worktrees/<slug> -b <type>/<slug>` ' +
    'or spawn a subagent with Workspace: "share"), symlink node_modules if present, ' +
    'and target all file edits and commands inside that worktree path.'
  );
}

export function isDocFile(filePath, repoRoot) {
  const rel = path.relative(repoRoot, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const normalized = rel.split(path.sep).join('/');
  return normalized === 'README.md' || normalized === 'AGENTS.md' || normalized.startsWith('docs/');
}

export function isRiggedRepo(repoRoot) {
  if (!repoRoot || typeof repoRoot !== 'string') return false;

  // Verify that .rig/hooks/pre-commit or legacy scripts/git-hooks/pre-commit exists in the repo
  if (
    existsSync(path.join(repoRoot, '.rig/hooks/pre-commit')) ||
    existsSync(path.join(repoRoot, 'scripts/git-hooks/pre-commit'))
  ) {
    return true;
  }

  // Verify whether git config --get core.hooksPath resolves to .rig/hooks or scripts/git-hooks
  try {
    const res = spawnSync('git', ['-C', repoRoot, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
    if (res.status === 0) {
      const hooksPath = res.stdout.trim();
      if (hooksPath) {
        const normalized = hooksPath.replace(/\\/g, '/').replace(/\/+$/, '');
        if (
          normalized === '.rig/hooks' ||
          normalized.endsWith('/.rig/hooks') ||
          normalized === 'scripts/git-hooks' ||
          normalized.endsWith('/scripts/git-hooks')
        ) {
          return true;
        }
        if (
          path.resolve(repoRoot, hooksPath) === path.resolve(repoRoot, '.rig/hooks') ||
          path.resolve(repoRoot, hooksPath) === path.resolve(repoRoot, 'scripts/git-hooks')
        ) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }

  return false;
}

function hasThirdPartyHookManager(repoRoot) {
  const artifacts = [
    '.husky',
    '.lefthook',
    'lefthook.yml',
    'lefthook.yaml',
    '.lefthook.yml',
    '.lefthook.yaml',
    '.pre-commit-config.yaml',
    '.pre-commit-config.yml',
  ];
  return artifacts.some((f) => existsSync(path.join(repoRoot, f)));
}

function registerRepoInState(repoRoot, homeDir) {
  if (!homeDir || homeDir === false) return;
  try {
    const p = path.join(homeDir, '.config', 'agent-rig', 'state.json');
    let data = { installedHarnesses: [], initializedRepos: [], installedSkills: [], nodeBin: null };
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        data = {
          installedHarnesses: Array.isArray(raw.installedHarnesses) ? raw.installedHarnesses : [],
          initializedRepos: Array.isArray(raw.initializedRepos) ? raw.initializedRepos : [],
          installedSkills: Array.isArray(raw.installedSkills) ? raw.installedSkills : [],
          nodeBin: typeof raw.nodeBin === 'string' ? raw.nodeBin : null,
        };
      } catch {
        // ignore parse error
      }
    }
    if (!data.initializedRepos.includes(repoRoot)) {
      data.initializedRepos.push(repoRoot);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
    }
  } catch {
    // ignore filesystem errors
  }
}

export function ensureRepoAttached(repoRoot, { homeDir = homedir() } = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') return { attached: false, hooksConfigured: false };

  const hasRigHook = existsSync(path.join(repoRoot, '.rig/hooks/pre-commit'));
  const hasLegacyHook = existsSync(path.join(repoRoot, 'scripts/git-hooks/pre-commit'));

  if (!hasRigHook && !hasLegacyHook) {
    return { attached: false, hooksConfigured: false };
  }

  let hooksPath = null;
  try {
    const res = spawnSync('git', ['-C', repoRoot, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      hooksPath = res.stdout.trim();
    }
  } catch {
    return { attached: false, hooksConfigured: false };
  }

  let hooksConfigured = false;
  if (!hooksPath) {
    if (hasRigHook && !hasThirdPartyHookManager(repoRoot)) {
      try {
        const setRes = spawnSync('git', ['-C', repoRoot, 'config', 'core.hooksPath', '.rig/hooks'], { encoding: 'utf8' });
        hooksConfigured = setRes.status === 0;
      } catch {
        // ignore
      }
    }
    registerRepoInState(repoRoot, homeDir);
    return { attached: true, hooksConfigured };
  }

  return { attached: true, hooksConfigured: false, alreadyConfigured: true };
}

export function checkEditTarget(filePath, options = {}) {
  const harness = options?.harness ?? 'generic';
  const cwd = (typeof options?.cwd === 'string' && options.cwd.trim()) ? options.cwd : process.cwd();
  if (typeof filePath !== 'string' || !filePath.trim()) return null;

  const absPath = path.resolve(cwd, filePath);
  const dir = existingAncestor(absPath, cwd);
  if (!dir) return null;

  const res = spawnSync(
    'git',
    ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) return null;

  const [gitDir, commonDir, topLevel] = res.stdout.trim().split('\n');
  if (!gitDir || !commonDir || !topLevel) return null;

  const repoRoot = path.dirname(commonDir);
  const targetRoot = isRiggedRepo(repoRoot) ? repoRoot : topLevel;
  if (isRiggedRepo(targetRoot)) {
    ensureRepoAttached(targetRoot, { homeDir: options?.homeDir });
  }

  const isRigged = isRiggedRepo(topLevel) || isRiggedRepo(repoRoot);

  // If the repository is not rigged under agent-rig conventions, permit edits
  // in the main checkout so globally-installed hooks do not block unrigged repos.
  if (!isRigged) return null;

  // Protect the agent-rig managed block in AGENTS.md across both main checkout and worktrees
  const isAgentsMd =
    path.resolve(absPath) === path.resolve(topLevel, 'AGENTS.md') ||
    path.resolve(absPath) === path.resolve(repoRoot, 'AGENTS.md');
  if (isAgentsMd && existsSync(absPath)) {
    try {
      const existingText = readFileSync(absPath, 'utf8');
      const startIdx = existingText.indexOf('<!-- AGENT-RIG:START -->');
      const endIdx = existingText.indexOf('<!-- AGENT-RIG:END -->');
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const managedEnd = endIdx + '<!-- AGENT-RIG:END -->'.length;
        const toolArgs = options?.toolArgs ?? {};
        const target = toolArgs.Target ?? toolArgs.old_string ?? toolArgs.target;
        if (typeof target === 'string' && target.length > 0) {
          let tIdx = existingText.indexOf(target);
          while (tIdx !== -1) {
            const tEnd = tIdx + target.length;
            if (tIdx < managedEnd && tEnd > startIdx) {
              return (
                'The block between <!-- AGENT-RIG:START --> and <!-- AGENT-RIG:END --> in AGENTS.md is managed by agent-rig (run `rig update` to refresh it). ' +
                'Only edit the `# Project Context` section below <!-- AGENT-RIG:END -->.'
              );
            }
            tIdx = existingText.indexOf(target, tIdx + 1);
          }
        }
        const newContent = toolArgs.Content ?? toolArgs.content;
        const append = Boolean(toolArgs.Append ?? toolArgs.append);
        if (typeof newContent === 'string' && !append) {
          const existingBlock = existingText.slice(startIdx, managedEnd);
          if (!newContent.includes(existingBlock)) {
            return (
              'The block between <!-- AGENT-RIG:START --> and <!-- AGENT-RIG:END --> in AGENTS.md is managed by agent-rig (run `rig update` to refresh it). ' +
              'Only edit the `# Project Context` section below <!-- AGENT-RIG:END -->.'
            );
          }
        }
      }
    } catch {
      // ignore read errors
    }
  }

  // In a linked worktree, --git-dir is <common>/worktrees/<name>; in the main
  // checkout the two paths are identical.
  if (gitDir !== commonDir) return null;

  // Documentation and backlog files can be edited directly in the main checkout.
  if (isDocFile(absPath, topLevel)) return null;

  return buildRemediation(harness);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let parsed;
  try {
    parsed = readHookInput();
  } catch {
    process.exit(0);
  }
  try {
    const reason = checkEditTarget(parsed.filePath, { harness: parsed.harness, cwd: parsed.cwd, toolArgs: parsed.toolArgs });
    if (reason) {
      emitDecision(parsed.schema, 'deny', reason);
    } else {
      emitDecision(parsed.schema, 'allow');
    }
  } catch {
    emitDecision(parsed.schema, 'allow');
  }
}
