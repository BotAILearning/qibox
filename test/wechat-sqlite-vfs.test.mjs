import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { python } from '../scripts/tooling.mjs';

// The production reader uses Linux libsqlite3. Keep the Python regression in
// the normal test entry point, in a child so its temporary default VFS cannot
// affect other tests. Windows does not provide this production library.
test('private SQLite snapshot reads without host VFS path resolution', {
  skip: process.platform !== 'linux' ? 'Production Linux libsqlite3 required' : false,
}, () => {
  const result = spawnSync(python, [fileURLToPath(new URL('./wechat_sqlite.py', import.meta.url))], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 1 test/);
  assert.match(result.stderr, /\bOK\b/);
});
