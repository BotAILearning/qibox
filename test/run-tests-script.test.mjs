import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTestArgs } from '../scripts/run-tests.mjs';

test('forwards Node test-runner options before the discovered test pattern', () => {
  assert.deepEqual(
    buildTestArgs(['--test-name-pattern=reply limit', '--test-concurrency=2']),
    ['--test', '--test-name-pattern=reply limit', '--test-concurrency=2', 'test/*.test.mjs'],
  );
});

test('preserves a caller-supplied positional test file before the default suite', () => {
  assert.deepEqual(
    buildTestArgs(['test/one.test.mjs']),
    ['--test', 'test/one.test.mjs', 'test/*.test.mjs'],
  );
});
