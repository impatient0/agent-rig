import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reflowMarkdown } from '../scripts/reflow-docs.mjs';

test('splits a paragraph into one sentence per line and is idempotent', () => {
  const input = '# Heading\n\nFirst sentence here. Second sentence follows!\n';
  const expected = '# Heading\n\nFirst sentence here.\nSecond sentence follows!\n';
  assert.equal(reflowMarkdown(input), expected);
  assert.equal(reflowMarkdown(expected), expected);
});
