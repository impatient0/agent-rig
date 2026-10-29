import { readFileSync } from 'node:fs';

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
    raw,
  };
}

export function readHookInput(options = {}) {
  const text = readFileSync(0, 'utf8');
  return parseHookInput(text, options);
}

/**
 * Formats the PreToolUse decision object for stdout.
 * Returns null when the schema expects silent exit 0 on allow (Claude Code).
 */
export function formatDecision(schema, decision, reason) {
  if (schema === 'claude') {
    if (decision === 'allow') return null;
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
    return JSON.stringify({ decision: 'allow' });
  }
  return JSON.stringify({
    decision,
    ...(reason ? { reason } : {}),
  });
}

export function emitDecision(schema, decision, reason) {
  const out = formatDecision(schema, decision, reason);
  if (out !== null) {
    process.stdout.write(`${out}\n`);
  }
}
