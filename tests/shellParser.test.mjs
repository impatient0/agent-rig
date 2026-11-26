import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripHeredocs,
  maskQuotes,
  tokenize,
  stripWrappers,
  parseCdSegment,
  parseNestedCommand,
  extractSubshells,
  parseStage,
  parseCommandLists,
  splitSegments,
} from '../hooks/lib/shell-parser.mjs';

test('stripHeredocs strips heredoc bodies while ignoring here-strings and quoted markers', () => {
  const withHeredoc = [
    "cat <<'EOF' > out.txt",
    'ssh prod-box',
    'cat .env',
    'EOF',
    'echo done',
  ].join('\n');
  assert.equal(stripHeredocs(withHeredoc), "cat <<'EOF' > out.txt\necho done");

  const withHereString = 'cat <<< "ssh prod-box"\necho ok';
  assert.equal(stripHeredocs(withHereString), withHereString);

  const quotedMarker = 'echo "literal <<EOF"\necho still-here';
  assert.equal(stripHeredocs(quotedMarker), quotedMarker);
});

test('tokenize handles quotes, escapes, adjacent quoted substrings, and command substitutions', () => {
  assert.deepEqual(
    tokenize(`FOO="bar baz" --rsh='ssh -p 2222' echo $(a | b) "escaped \\"quote\\""`),
    ['FOO=bar baz', '--rsh=ssh -p 2222', 'echo', '$(a | b)', 'escaped "quote"'],
  );
  assert.equal(maskQuotes(`echo "ssh host" 'cat .env'`), 'echo "" ""');
});

test('stripWrappers strips env assignments and wrapper binaries', () => {
  const res = stripWrappers(['FOO=1', 'sudo', 'env', 'BAR=2', 'nohup', '/usr/bin/cat', '.env']);
  assert.equal(res.bin, 'cat');
  assert.deepEqual(res.rest, ['.env']);
  assert.deepEqual(res.envAssignments, ['FOO=1', 'BAR=2']);
  assert.deepEqual(res.wrappers, ['sudo', 'env', 'nohup']);
});

test('parseCdSegment and parseNestedCommand handle wrappers and shell -c variants', () => {
  assert.equal(parseCdSegment('cd -P .worktrees/feat-1'), '.worktrees/feat-1');
  assert.equal(parseCdSegment('cd -- -weird'), '-weird');
  assert.equal(parseCdSegment('echo hi'), null);

  assert.equal(parseNestedCommand('sudo bash -lc "sops -d a.yaml"'), 'sops -d a.yaml');
  assert.equal(parseNestedCommand('sh -c "git push"'), 'git push');
  assert.equal(parseNestedCommand('eval "cat .env"'), 'cat .env');
  assert.equal(parseNestedCommand('bash script.sh'), null);
});

test('extractSubshells extracts $(...) and backticks outside single quotes', () => {
  const cmd = `echo "$(cat .env)" '$(ignored)' \`ssh box\` $(nested $(inner))`;
  assert.deepEqual(extractSubshells(cmd), ['cat .env', 'ssh box', 'nested $(inner)']);
});

test('parseStage cleans redirections from tokens and tracks stdout destinations', () => {
  const term = parseStage('sops -d secrets.sops.yaml 2>/dev/null');
  assert.equal(term.bin, 'sops');
  assert.deepEqual(term.tokens, ['sops', '-d', 'secrets.sops.yaml']);
  assert.equal(term.stdoutDestination, 'terminal');
  assert.deepEqual(term.redirections.map((r) => ({ op: r.op, fd: r.fd, target: r.target, isDevNull: r.isDevNull })), [
    { op: '2>', fd: 2, target: '/dev/null', isDevNull: true },
  ]);

  const devNull = parseStage('sops -d secrets.sops.yaml >/dev/null 2>&1');
  assert.deepEqual(devNull.tokens, ['sops', '-d', 'secrets.sops.yaml']);
  assert.equal(devNull.stdoutDestination, 'devnull');
  assert.equal(devNull.stdoutTarget, '/dev/null');
  assert.equal(devNull.redirections[1].op, '2>&1');
  assert.equal(devNull.redirections[1].isFdDup, true);

  const andGt = parseStage('sops -d secrets.sops.yaml &>/dev/null');
  assert.equal(andGt.stdoutDestination, 'devnull');
  assert.equal(andGt.redirections[0].op, '&>');
  assert.equal(andGt.redirections[0].fd, 'all');

  const toFile = parseStage('sops -d secrets.sops.yaml >> out.yaml');
  assert.equal(toFile.stdoutDestination, 'file');
  assert.equal(toFile.stdoutTarget, 'out.yaml');
  assert.equal(toFile.redirections[0].op, '>>');

  const inputRedir = parseStage('cat<.env');
  assert.deepEqual(inputRedir.tokens, ['cat']);
  assert.deepEqual(inputRedir.inputFiles, ['.env']);
  assert.equal(inputRedir.redirections[0].op, '<');

  const quotedGt = parseStage('grep "a > b" src/app.js');
  assert.deepEqual(quotedGt.tokens, ['grep', 'a > b', 'src/app.js']);
  assert.equal(quotedGt.redirections.length, 0);
});

test('parseCommandLists separates command lists from pipeline stages and respects grouping', () => {
  const cmd = [
    'cd .worktrees/a && sops -d secrets.sops.yaml | jq . > /dev/null; (cat .env |& grep -q KEY)',
    'echo "a && b | c" # comment with | and ;',
  ].join('\n');

  const lists = parseCommandLists(cmd);
  assert.equal(lists.length, 4);

  assert.equal(lists[0].stages[0].bin, 'cd');
  assert.equal(lists[1].separatorBefore, '&&');
  assert.equal(lists[1].stages.length, 2);
  assert.equal(lists[1].stages[0].bin, 'sops');
  assert.equal(lists[1].stages[0].pipeOut, '|');
  assert.equal(lists[1].stages[0].stdoutDestination, 'pipe');
  assert.equal(lists[1].stages[1].bin, 'jq');
  assert.equal(lists[1].stages[1].pipeIn, '|');
  assert.equal(lists[1].stages[1].pipeOut, null);
  assert.equal(lists[1].stages[1].stdoutDestination, 'devnull');

  assert.equal(lists[2].stages.length, 2);
  assert.equal(lists[2].stages[0].bin, 'cat');
  assert.equal(lists[2].stages[0].pipeOut, '|&');
  assert.equal(lists[2].stages[1].bin, 'grep');

  assert.equal(lists[3].stages[0].bin, 'echo');
  assert.deepEqual(lists[3].stages[0].tokens, ['echo', 'a && b | c']);
  assert.equal(splitSegments('a && b | c; d').length, 4);
});
