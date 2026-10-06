import path from 'node:path';
import { readFile, writeFile, mkdir, cp, rm, readdir, stat, rename, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import sharp from 'sharp';
import { root, python, run } from './tooling.mjs';
import { hashFile, within } from '../server/files.mjs';
import { download } from './download.mjs';
import { architecture, runtimeArchives } from '../server/platform.mjs';
import { prepareFonts } from './prepare-fonts.mjs';
import { checkWebAssets } from './check-web-assets.mjs';
const requestedArch = process.argv.find(x => x.startsWith('--arch='))?.slice(7) || 'all';
const targets = requestedArch === 'all' ? [architecture('x64'), architecture('arm64')] : [architecture(requestedArch)];
const host = 'fnos';
const product = { ...JSON.parse(await readFile(path.join(root, 'config/product.json'), 'utf8')), platform: targets.length === 2 ? 'all' : targets[0].fnos };
const iconRevision = createHash('sha256').update(await readFile(path.join(root, 'web/icon.png'))).digest('hex').slice(0, 16);
const out = path.join(root, 'public'); await mkdir(out, { recursive: true });
await rm(path.join(out, 'icon.svg'), { force: true });
for (const file of ['index.html', 'style.css', 'ai-workspace.css', 'ui-foundation.css', 'qibox-components.css', 'qibox-modules.css', 'icon.png', 'auth-callback.html', 'privacy.html', 'terms.html']) await cp(path.join(root, 'web', file), path.join(out, file));
await cp(path.join(root, 'web/vendor/qiapp-ui'), path.join(out, 'vendor/qiapp-ui'), { recursive: true });
await cp(path.join(root, 'web/qiapp-product.css'), path.join(out, 'qiapp-product.css'));
for (const file of ['index.html', 'auth-callback.html']) {
  const html = await readFile(path.join(out, file), 'utf8');
  await writeFile(path.join(out, file), html.replaceAll('./icon.png', `./icon.png?v=${iconRevision}`));
}
await cp(path.join(root, 'web/backgrounds'), path.join(out, 'backgrounds'), { recursive: true });
for (const name of ['app', 'auth-callback']) await build({ entryPoints: [path.join(root, `web/${name}.mjs`)], outfile: path.join(out, `${name}.js`), bundle: true, format: 'esm', platform: 'browser', target: ['chrome110', 'safari16'], define: { __QIBOX_HOST__: JSON.stringify(host) }, minify: true, legalComments: 'inline' });
for (const name of (await readdir(out)).filter(name => name.endsWith('.html'))) {
  const file = path.join(out, name); let html = await readFile(file, 'utf8');
  for (const match of html.matchAll(/(?:src|href)=["']\.\/([^"'?]+\.(?:js|css))["']/g)) {
    const revision = createHash('sha256').update(await readFile(path.join(out, match[1]))).digest('hex').slice(0, 16);
    html = html.replaceAll(`./${match[1]}`, `./${match[1]}?v=${revision}`);
  }
  await writeFile(file, html);
}
await checkWebAssets(out);
console.log('Web application built');
if (!process.argv.includes('--ui-only')) {
  await prepareFonts();
  const directory = within(path.join(root, 'build'), path.join(root, 'build', `${product.appname}-${requestedArch}`));
  await rm(directory, { recursive: true, force: true });
  const app = path.join(directory, 'app'); await mkdir(app, { recursive: true });
  await cp(path.join(root, 'packaging'), directory, { recursive: true });
  for (const name of ['server', 'public', 'config', 'licenses', 'fonts']) await cp(path.join(root, name), path.join(app, name), { recursive: true, filter: file => !file.includes('__pycache__') && !/[\\/](?:ugos-native|@ugreen-nas)(?:[\\/]|$)/i.test(file) && !/\.(?:bak|before)(?:$|[.\-_])/i.test(path.basename(file)) });
  await writeFile(path.join(app, 'config/product.json'), JSON.stringify(product, null, 2) + '\n');
  for (const name of ['README.md', 'NOTICE.md']) await cp(path.join(root, name), path.join(app, name));
  for (const name of ['ws', 'pdfkit', 'fflate', 'fontkit', 'linebreak', 'png-js', '@noble', '@swc', 'brotli', 'base64-js', 'clone', 'dfa', 'fast-deep-equal', 'restructure', 'tiny-inflate', 'unicode-properties', 'unicode-trie', 'tslib']) {
    // Node-only consumer packages: retain both Node import/require entries,
    // runtime data and licenses; browser bundles and JS debugging maps are not
    // used by the server or the separately built web application.
    await cp(path.join(root, 'node_modules', name), path.join(app, 'node_modules', name), { recursive: true,
      filter: file => !/\.(?:js|cjs|mjs)\.map$/.test(file) &&
        !(name === 'pdfkit' && /^pdfkit\.(?:browser|old|standalone)/.test(path.basename(file))) &&
        !(name === 'fontkit' && /^browser(?:-module)?\.(?:cjs|mjs)$/.test(path.basename(file))) });
  }
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: product.appname, version: product.version, type: 'module', private: true }));
  let components = 0;
  await run(python, [path.join(root, 'scripts/prepare-runtime-solid.py')]);
  const sharedPayload = path.join(app, 'payload/shared'); await mkdir(sharedPayload, { recursive: true });
  const copiedPayloads = new Set();
  for (const target of targets) {
  const lockName = target.node === 'arm64' ? 'runtime-lock-arm64.json' : 'runtime-lock.json';
  const slimLock = path.join(root, '.cache/runtime-solid', target.node, 'runtime-lock.json');
  const lock = JSON.parse(await readFile(slimLock, 'utf8'));
  if (lock.wechat || lock.packages.some(x => /wechat/i.test(x.name))) throw new Error('WeChat must never be bundled');
  const payload = path.join(app, 'payload', target.node); await mkdir(payload, { recursive: true });
  await cp(slimLock, path.join(payload, 'runtime-lock.json'));
  for (const entry of runtimeArchives(lock)) {
    if (!/^[a-f0-9]{64}$/.test(entry.payloadSha256) || entry.payloadFile !== `${entry.payloadSha256}-data.tar.xz`) throw new Error('Invalid shared payload reference');
    const source = path.join(root, '.cache/runtime-solid/shared', entry.payloadFile);
    if (!copiedPayloads.has(entry.payloadFile)) {
      if (await hashFile(source) !== entry.payloadSha256) throw new Error(`Hash mismatch: ${entry.file}`);
      await cp(source, path.join(sharedPayload, entry.payloadFile)); copiedPayloads.add(entry.payloadFile);
    }
  }
  components += lock.packages.length;
  }
  await cp(path.join(root, '.cache/runtime-solid/provenance.json'), path.join(app, 'payload/provenance.json'));
  const licenseRoot = path.join(app, 'licenses/npm'); await mkdir(licenseRoot, { recursive: true });
  for (const [name, license] of [['ws', 'LICENSE'], ['@novnc/novnc', 'LICENSE.txt'], ['@trimjs/web-app', 'package.json']]) {
    await mkdir(path.join(licenseRoot, name), { recursive: true });
    await cp(path.join(root, 'node_modules', name, license), path.join(licenseRoot, name, license));
  }
  for (const name of ['pdfkit', 'fflate', 'fontkit', 'linebreak', 'png-js', '@noble/ciphers', '@noble/hashes', '@swc/helpers', 'brotli', 'base64-js', 'clone', 'dfa', 'fast-deep-equal', 'restructure', 'tiny-inflate', 'unicode-properties', 'unicode-trie', 'tslib']) {
    const source = path.join(root, 'node_modules', name);
    const license = (await readdir(source)).find(file => /^licen[sc]e(?:\.[a-z0-9]+)?$/i.test(file)) || 'package.json';
    await mkdir(path.join(licenseRoot, name), { recursive: true });
    await cp(path.join(source, license), path.join(licenseRoot, name, license));
  }
  // Restore these exact bytes during installation, before the service imports
  // its dependencies. Both architectures share the same application resources.
  await run(python, [path.join(root, 'scripts/prepare-app-assets.py'), app]);
  for (const name of ['fonts', 'node_modules']) await rm(within(app, path.join(app, name)), { recursive: true });
  const ui = path.join(app, 'ui'); await mkdir(path.join(ui, 'images'), { recursive: true });
  await writeFile(path.join(ui, 'config'), JSON.stringify({ '.url': { [`${product.appname}.Application`]: { title: product.displayName, icon: `images/qibox-${iconRevision}_{0}.png`, type: 'url', protocol: '', gatewayPrefix: product.gatewayPrefix, gatewaySocket: 'app.sock', url: `${product.gatewayPrefix}/`, allUsers: true } } }, null, 2));
  for (const pixels of [64, 256]) {
    const icon = await sharp(path.join(root, 'web/icon.png')).resize(pixels, pixels).png().toBuffer();
    await writeFile(path.join(ui, `images/qibox-${iconRevision}_${pixels}.png`), icon); await writeFile(path.join(directory, pixels === 64 ? 'ICON.PNG' : 'ICON_256.PNG'), icon);
  }
  const manifest = { appname: product.appname, version: product.version, display_name: product.displayName, desc: '在 NAS 上安装应用，支持微信多开和持续备份。', platform: product.platform, os_min_version: product.minOSVersion, source: 'thirdparty', maintainer: product.publisher, distributor: product.publisher, desktop_uidir: 'ui', desktop_applaunchname: `${product.appname}.Application`, install_dep_apps: 'nodejs_v22', ctl_stop: 'true', checkport: 'false', micro_app: 'true' };
  await writeFile(path.join(directory, 'manifest'), Object.entries(manifest).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  await mkdir(path.join(directory, 'wizard'), { recursive: true });
  for (const name of ['install_init', 'config_init', 'config_callback', 'uninstall_callback']) await writeFile(path.join(directory, 'cmd', name), '#!/bin/bash\nexit 0\n');
  for (const name of ['install_callback', 'upgrade_callback']) await writeFile(path.join(directory, 'cmd', name), '#!/bin/bash\nset -eu\nexport PATH="/var/apps/nodejs_v22/target/bin:/usr/local/bin:/usr/bin:/bin"\n: "${TRIM_APPDEST:?}"\nnode "${TRIM_APPDEST}/server/app-assets.mjs"\n');
  for (const name of ['upgrade_init', 'uninstall_init']) await writeFile(path.join(directory, 'cmd', name), '#!/bin/bash\nset -eu\nSCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\n"${SCRIPT_DIR}/main" stop\n');
  for (const name of await readdir(path.join(directory, 'cmd'))) {
    const file = path.join(directory, 'cmd', name); await writeFile(file, (await readFile(file, 'utf8')).replaceAll('\r\n', '\n')); await chmod(file, 0o755);
  }
  if (process.argv.includes('--stage-only')) {
    console.log(`Package inputs prepared: ${directory} (${components} runtime components)`);
  } else {
  const windows = process.platform === 'win32'; const fnpack = path.join(root, '.cache/tools', windows ? 'fnpack.exe' : 'fnpack');
  await download(`https://static2.fnnas.com/fnpack/fnpack-1.2.3-${windows ? 'windows-amd64' : 'linux-amd64'}`, fnpack); if (!windows) await chmod(fnpack, 0o755);
  const dist = product.buildId ? path.join(root, 'dist/releases', product.version, product.buildId) : path.join(root, 'dist'); await mkdir(dist, { recursive: true });
  await run(fnpack, ['build', '--directory', directory], { cwd: dist });
  const result = path.join(dist, `${product.appname}-${product.buildId || product.version}-${product.platform}.fpk`);
  if (await stat(result).catch(() => null)) throw new Error('Build already exists; allocate a new build ID');
  await rename(path.join(dist, `${product.appname}.fpk`), result);
  await run(python, [path.join(root, 'scripts/normalize-fpk.py'), result]);
  await run(python, [path.join(root, 'scripts/verify-fpk.py'), result]);
  await writeFile(`${result}.sha256`, `${await hashFile(result)}  ${path.basename(result)}\n`);
  console.log(`Package: ${result} (${((await stat(result)).size / 1024 ** 2).toFixed(1)} MiB; ${components} runtime components)`);
  }
}
