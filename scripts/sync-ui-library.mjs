// Explicit, version-locked vendor update. Normal builds never read another repo.
import { readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root } from './tooling.mjs';
const source = path.resolve(process.argv[2] || 'D:/app开发/UI通用组件库');
const pkg = JSON.parse(await readFile(path.join(source, 'packages/ui/package.json'), 'utf8'));
const spec = await readFile(path.join(source, 'docs/design-system.md'), 'utf8');
if (pkg.version !== '0.2.0' || !spec.includes('规范修订：2026-10-19.2')) throw Error('UI baseline changed; review before updating');
const files = ['styles.css', 'tokens.css', 'brands.css', 'base.css', 'components.css', 'settings.css', 'ai.css', 'composition.css'];
const target = path.join(root, 'web/vendor/qiapp-ui');
await mkdir(target, { recursive: true });
const hashes = {};
for (const file of files) {
  const src = path.join(source, 'packages/ui/src', file);
  hashes[file] = createHash('sha256').update(await readFile(src)).digest('hex');
  await cp(src, path.join(target, file));
}
await writeFile(path.join(target, 'source-lock.json'), JSON.stringify({ package: '@qiapp/ui', version: pkg.version, revision: '2026-10-19.2', files: hashes }, null, 2) + '\n');
await writeFile(path.join(target, 'SOURCE.md'), '# QIAPP UI source\n\nPinned @qiapp/ui 0.2.0 / specification 2026-10-19.2.\nSource: D:/app开发/UI通用组件库/packages/ui/src.\nCSS is copied without modifications; source-lock.json records SHA-256.\nRefresh only with scripts/sync-ui-library.mjs after an explicit version review.\nNative HTML classes only; no claim of JavaScript Web Component integration.\nLegacy product CSS is in a lower cascade layer; public component states and density remain owned by the shared library.\n');
await writeFile(path.join(target, 'SETTINGS-SOURCE.md'), '# Settings source\n\nsettings.css is part of the same pinned 0.2.0 runtime. See SOURCE.md and source-lock.json.\n');
console.log('Pinned QIAPP UI', pkg.version, files.length, 'CSS files');
