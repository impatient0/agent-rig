#!/usr/bin/env node
// CLI for agent-rig:
//   rig install-global [--harnesses antigravity,claude,...] [--detected] [--home <dir>] [--force]
//   rig init [<target-dir>] [--self-contained] [--no-worktrees] [--ui] [--force]
//   rig detach [<target-dir>]
//   rig check-docs [<target-dir>]
//   rig reflow-docs [<target-dir>] [--check]
//   rig status [<target-dir>]

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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

function linkSafe(src, dest, { force = false, linked = [], skipped = [] } = {}) {
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

function installForAntigravity(homeDir, { force = false, linked = [], skipped = [], updated = [] }) {
  const configDir = path.join(homeDir, '.gemini', 'config');
  const pluginsDir = path.join(configDir, 'plugins');
  const pluginLink = path.join(pluginsDir, 'agent-rig');
  mkdirSync(pluginsDir, { recursive: true });

  linkSafe(RIG_ROOT, pluginLink, { force, linked, skipped });

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

function installForClaude(homeDir, { force = false, linked = [], skipped = [], updated = [] }) {
  const claudeDir = path.join(homeDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const skillsDir = path.join(RIG_ROOT, 'skills');
  for (const skill of readdirSync(skillsDir)) {
    linkSafe(path.join(skillsDir, skill), path.join(claudeDir, 'skills', skill), { force, linked, skipped });
  }

  for (const rule of ['AGENTS.md', 'ui-change-gate.md']) {
    linkSafe(path.join(RIG_ROOT, 'rules', rule), path.join(claudeDir, 'rules', rule), { force, linked, skipped });
  }

  for (const hookEntry of ['guard-remote-mutation.mjs', 'guard-main-checkout-edits.mjs', 'guard-symlinked-node-modules.mjs', 'lib']) {
    linkSafe(path.join(RIG_ROOT, 'hooks', hookEntry), path.join(claudeDir, 'hooks', hookEntry), { force, linked, skipped });
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

function installForCodex(homeDir, { force = false, linked = [], skipped = [] }) {
  const codexDir = path.join(homeDir, '.codex');
  mkdirSync(codexDir, { recursive: true });
  const skillsDir = path.join(RIG_ROOT, 'skills');
  for (const skill of readdirSync(skillsDir)) {
    linkSafe(path.join(skillsDir, skill), path.join(codexDir, 'skills', skill), { force, linked, skipped });
  }
  linkSafe(path.join(RIG_ROOT, 'rules/AGENTS.md'), path.join(codexDir, 'AGENTS.md'), { force, linked, skipped });
}

function installForCursor(homeDir, { force = false, linked = [], skipped = [] }) {
  const cursorDir = path.join(homeDir, '.cursor');
  mkdirSync(cursorDir, { recursive: true });
  const skillsDir = path.join(RIG_ROOT, 'skills');
  for (const skill of readdirSync(skillsDir)) {
    linkSafe(path.join(skillsDir, skill), path.join(cursorDir, 'skills', skill), { force, linked, skipped });
  }
  linkSafe(path.join(RIG_ROOT, 'rules/AGENTS.md'), path.join(cursorDir, 'rules/AGENTS.md'), { force, linked, skipped });
}

export function installGlobal({
  homeDir = homedir(),
  harnesses = null,
  detectedOnly = false,
  force = false,
} = {}) {
  const discovered = detectHarnesses(homeDir);
  let selectedIds;
  if (Array.isArray(harnesses) && harnesses.length > 0) {
    selectedIds = harnesses.map((h) => h.trim().toLowerCase()).filter(Boolean);
  } else if (detectedOnly) {
    selectedIds = discovered.filter((d) => d.detected).map((d) => d.id);
  } else {
    selectedIds = discovered.filter((d) => d.detected).map((d) => d.id);
  }

  const linked = [];
  const skipped = [];
  const updated = [];

  for (const id of selectedIds) {
    if (id === 'antigravity') installForAntigravity(homeDir, { force, linked, skipped, updated });
    else if (id === 'claude') installForClaude(homeDir, { force, linked, skipped, updated });
    else if (id === 'codex') installForCodex(homeDir, { force, linked, skipped });
    else if (id === 'cursor') installForCursor(homeDir, { force, linked, skipped });
    else throw new Error(`Unknown harness id: ${id}`);
  }

  return {
    discovered,
    installedHarnesses: selectedIds,
    linked,
    skipped,
    updated,
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

  const statusRes = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
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

export function initRepo(
  targetDir,
  { selfContained = false, worktrees = true, ui = false, force = false } = {},
) {
  const dir = path.resolve(targetDir);
  mkdirSync(dir, { recursive: true });

  const copied = [];
  const skipped = [];
  const merged = [];

  // 1. Minimal project docs & templates
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

  // 2. Git hooks for worktree isolation
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
  }

  // 3. Optional --self-contained mode: bundle skills, rules, hooks, and doc linters inside the repo
  if (selfContained) {
    const skillsDir = path.join(RIG_ROOT, 'skills');
    for (const skill of readdirSync(skillsDir)) {
      copyFileSafe(path.join(skillsDir, skill), path.join(dir, 'skills', skill), { force, copied, skipped });
    }
    copyFileSafe(path.join(RIG_ROOT, 'rules/AGENTS.md'), path.join(dir, 'rules/AGENTS.md'), { force, copied, skipped });
    copyFileSafe(path.join(RIG_ROOT, 'rules/ui-change-gate.md'), path.join(dir, 'rules/ui-change-gate.md'), {
      force,
      copied,
      skipped,
    });
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

    // Install hooks into hooks/ and .claude/hooks/ and merge .claude/settings.json for self-contained repos
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

  const worktreeHead = worktrees
    ? detachMainCheckout(dir, { reanchorToMain: false })
    : { detached: false, status: 'skipped' };

  return {
    copied,
    skipped,
    merged,
    hooksConfigured,
    worktreeHead,
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

  if (cmd === 'install-global') {
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

    const res = installGlobal({ homeDir, harnesses, detectedOnly, force });
    console.log(`rig install-global: configured [${res.installedHarnesses.join(', ')}]`);
    console.log(`  linked: ${res.linked.length}, updated configs: ${res.updated.length}, skipped: ${res.skipped.length}`);
    return;
  }

  if (cmd === 'init') {
    const pos = args.slice(1).find((a) => !a.startsWith('-')) ?? process.cwd();
    const selfContained = args.includes('--self-contained');
    const worktrees = !args.includes('--no-worktrees');
    const ui = args.includes('--ui');
    const res = initRepo(pos, { selfContained, worktrees, ui, force });
    console.log(`rig init (${path.resolve(pos)}): copied ${res.copied.length}, merged ${res.merged.length}, skipped ${res.skipped.length}`);
    if (res.worktreeHead.status === 'dirty') {
      console.log('  note: working tree has uncommitted files; commit them and run "rig detach" to park HEAD detached at main.');
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
  rig install-global [--harnesses antigravity,claude,codex,cursor] [--detected] [--force]
  rig init [<target-dir>] [--self-contained] [--no-worktrees] [--ui] [--force]
  rig detach [<target-dir>]
  rig check-docs [<target-dir>]
  rig reflow-docs [<target-dir>] [--check]
  rig status [<target-dir>]`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
