import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHookInput, formatDecision, resolveHarness } from '../hooks/lib/hook-io.mjs';

test('parses Antigravity PreToolUse payload and formats { decision, reason } output', () => {
  const input = JSON.stringify({
    conversationId: 'conv-1',
    workspacePaths: ['/tmp/project'],
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'ssh prod-box uptime' },
    },
  });
  const parsed = parseHookInput(input, { argv: ['--harness=antigravity'], env: {} });
  assert.equal(parsed.harness, 'antigravity');
  assert.equal(parsed.schema, 'antigravity');
  assert.equal(parsed.toolName, 'run_command');
  assert.equal(parsed.command, 'ssh prod-box uptime');
  assert.equal(parsed.cwd, '/tmp/project');

  assert.deepEqual(JSON.parse(formatDecision(parsed.schema, 'allow')), { decision: 'allow' });
  assert.deepEqual(JSON.parse(formatDecision(parsed.schema, 'ask', 'confirm ssh')), {
    decision: 'ask',
    reason: 'confirm ssh',
  });
});

test('parses Claude Code PreToolUse payload and formats hookSpecificOutput envelope', () => {
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: '/tmp/project/src/index.js' },
    cwd: '/tmp/project',
  });
  const parsed = parseHookInput(input, { argv: ['--harness=claude'], env: {} });
  assert.equal(parsed.harness, 'claude');
  assert.equal(parsed.schema, 'claude');
  assert.equal(parsed.filePath, '/tmp/project/src/index.js');
  assert.equal(parsed.cwd, '/tmp/project');

  assert.equal(formatDecision(parsed.schema, 'allow'), null);
  assert.deepEqual(JSON.parse(formatDecision(parsed.schema, 'deny', 'worktree required')), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'worktree required',
    },
  });
});

test('a third-party harness using Claude JSON schema without --harness=claude keeps generic harness identity', () => {
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: '/tmp/project/src/index.js' },
  });
  const parsed = parseHookInput(input, { argv: [], env: {} });
  assert.equal(parsed.schema, 'claude');
  assert.equal(parsed.harness, 'generic');
  assert.equal(resolveHarness([], {}), 'generic');
});
