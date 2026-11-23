import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Finds the nearest existing directory ancestor for a target file or directory path.
 */
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

/**
 * Resolves git worktree and repository root paths for a directory, or null if not in a git repository.
 */
export function resolveGitRoots(dir) {
  if (!dir || typeof dir !== 'string') return null;
  try {
    const res = spawnSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    const [gitDir, commonDir, topLevel] = res.stdout.trim().split('\n');
    if (!gitDir || !commonDir || !topLevel) return null;
    return { gitDir, commonDir, topLevel, repoRoot: path.dirname(commonDir) };
  } catch {
    return null;
  }
}

export function isRigHooksPath(repoRoot, hooksPath) {
  if (!repoRoot || !hooksPath || typeof hooksPath !== 'string') return false;
  const trimmed = hooksPath.trim();
  if (!trimmed) return false;
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (
    normalized === '.rig/hooks' ||
    normalized.endsWith('/.rig/hooks') ||
    normalized === 'scripts/git-hooks' ||
    normalized.endsWith('/scripts/git-hooks')
  ) {
    return true;
  }
  return (
    path.resolve(repoRoot, trimmed) === path.resolve(repoRoot, '.rig/hooks') ||
    path.resolve(repoRoot, trimmed) === path.resolve(repoRoot, 'scripts/git-hooks')
  );
}

/**
 * Checks whether a repository root has worktree-isolation pre-commit hooks rigged
 * (governed by docs/adr/0004-strict-unrigged-repository-isolation.md).
 */
export function isWorktreeRiggedRepo(repoRoot) {
  if (!repoRoot || typeof repoRoot !== 'string') return false;

  if (
    existsSync(path.join(repoRoot, '.rig/hooks/pre-commit')) ||
    existsSync(path.join(repoRoot, 'scripts/git-hooks/pre-commit'))
  ) {
    return true;
  }

  try {
    const res = spawnSync('git', ['-C', repoRoot, 'config', '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status === 0 && typeof res.stdout === 'string') {
      if (isRigHooksPath(repoRoot, res.stdout)) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Canonical check for whether a repository root is rigged under agent-rig
 * (governed by docs/adr/0004-strict-unrigged-repository-isolation.md).
 * Covers both worktree-rigged repos and `--no-worktrees` repos with `.rig/`,
 * and returns false after `rig eject` or in unrigged repositories.
 */
export function isRiggedRepo(repoRoot) {
  if (!repoRoot || typeof repoRoot !== 'string') return false;
  if (isWorktreeRiggedRepo(repoRoot)) return true;
  if (
    existsSync(path.join(repoRoot, '.rig/hooks/guard-remote-mutation.mjs')) ||
    existsSync(path.join(repoRoot, '.rig/bin/rig.mjs'))
  ) {
    return true;
  }
  return false;
}

/**
 * Checks whether an arbitrary file or directory path resides inside a rigged repository
 * (governed by docs/adr/0004-strict-unrigged-repository-isolation.md).
 */
export function isDirectoryInRiggedRepo(targetPath, cwd = process.cwd()) {
  const dir = existingAncestor(targetPath, cwd);
  if (!dir) return false;
  const roots = resolveGitRoots(dir);
  if (roots) {
    return isRiggedRepo(roots.topLevel) || isRiggedRepo(roots.repoRoot);
  }
  let cur = dir;
  while (cur) {
    if (isRiggedRepo(cur)) return true;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

/**
 * Resolves the declared harness identity from explicit CLI flags (--harness=...)
 * or documented environment variables, defaulting to 'generic'.
 */
export function resolveHarness(argv = process.argv.slice(2), env = process.env) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--harness=')) {
      return arg.slice('--harness='.length).trim().toLowerCase() || 'generic';
    }
    if (arg === '--harness' && typeof argv[i + 1] === 'string') {
      return argv[i + 1].trim().toLowerCase() || 'generic';
    }
  }
  if (env.CLAUDE_PROJECT_DIR || env.CLAUDE_PLUGIN_ROOT) {
    return 'claude';
  }
  return 'generic';
}

/**
 * Parses a PreToolUse hook stdin payload according to documented schemas:
 * - Antigravity: { toolCall: { name, args: { CommandLine, Path } }, workspacePaths: [...] }
 * - Claude Code: { hook_event_name, tool_name, tool_input: { command, file_path }, cwd }
 * - Generic fallback: { command, filePath, cwd }
 */
export function parseHookInput(rawText, { argv = process.argv.slice(2), env = process.env, defaultCwd = process.cwd() } = {}) {
  const harness = resolveHarness(argv, env);
  const raw = JSON.parse(rawText);

  if (raw && typeof raw.toolCall === 'object' && raw.toolCall !== null) {
    const args = raw.toolCall.args ?? {};
    const ws = Array.isArray(raw.workspacePaths) && typeof raw.workspacePaths[0] === 'string' && raw.workspacePaths[0]
      ? raw.workspacePaths[0]
      : defaultCwd;
    return {
      harness: harness === 'generic' ? 'antigravity' : harness,
      schema: 'antigravity',
      toolName: typeof raw.toolCall.name === 'string' ? raw.toolCall.name : '',
      command: typeof args.CommandLine === 'string' ? args.CommandLine : (typeof args.command === 'string' ? args.command : ''),
      filePath: typeof args.Path === 'string' ? args.Path : (typeof args.file_path === 'string' ? args.file_path : ''),
      cwd: ws,
      toolArgs: args,
      raw,
    };
  }

  if (raw && (typeof raw.tool_input === 'object' || typeof raw.hook_event_name === 'string')) {
    const ti = raw.tool_input ?? {};
    return {
      harness,
      schema: 'claude',
      toolName: typeof raw.tool_name === 'string' ? raw.tool_name : '',
      command: typeof ti.command === 'string' ? ti.command : '',
      filePath: typeof ti.file_path === 'string' ? ti.file_path : '',
      cwd: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : defaultCwd,
      toolArgs: ti,
      raw,
    };
  }

  return {
    harness,
    schema: 'generic',
    toolName: typeof raw?.toolName === 'string' ? raw.toolName : '',
    command: typeof raw?.command === 'string' ? raw.command : (typeof raw?.CommandLine === 'string' ? raw.CommandLine : ''),
    filePath: typeof raw?.filePath === 'string' ? raw.filePath : (typeof raw?.Path === 'string' ? raw.Path : ''),
    cwd: typeof raw?.cwd === 'string' && raw.cwd ? raw.cwd : defaultCwd,
    toolArgs: raw?.toolArgs ?? raw?.args ?? raw?.tool_input ?? {},
    raw,
  };
}

export function readHookInput(options = {}) {
  const text = readFileSync(0, 'utf8');
  return parseHookInput(text, options);
}

/**
 * Formats the PreToolUse decision object for stdout.
 * Returns null when the schema expects silent exit 0 on allow (Claude Code),
 * unless `explicitAllow: true` is passed to explicitly approve an allowlisted command.
 */
export function formatDecision(schema, decision, reason, { explicitAllow = false } = {}) {
  if (schema === 'claude') {
    if (decision === 'allow') {
      if (!explicitAllow) return null;
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          ...(reason ? { permissionDecisionReason: reason } : {}),
        },
      });
    }
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    });
  }

  // Antigravity and generic JSON hook contract
  if (decision === 'allow') {
    return JSON.stringify({
      decision: 'allow',
      ...(explicitAllow && reason ? { reason } : {}),
    });
  }
  return JSON.stringify({
    decision,
    ...(reason ? { reason } : {}),
  });
}

export function emitDecision(schema, decision, reason, options) {
  const out = formatDecision(schema, decision, reason, options);
  if (out !== null) {
    process.stdout.write(`${out}\n`);
  }
}
