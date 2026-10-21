import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Build the Node test-runner argument list with caller options before test
 * paths. Node treats options after a test path as positional arguments, which
 * made `npm test -- --test-name-pattern=...` silently ineffective before.
 */
export function buildTestArgs(args = []) {
  return ['--test', ...args, 'test/*.test.mjs'];
}

export function runTests(args = [], options = {}) {
  const result = spawnSync(process.execPath, buildTestArgs(args), {
    cwd: options.cwd ?? process.cwd(),
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    process.stderr.write(`Failed to start Node test runner: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runTests(process.argv.slice(2));
}
