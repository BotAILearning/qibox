import path from 'node:path';
import { readFile, writeFile, mkdir, cp, rm, readdir, stat, rename, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import sharp from 'sharp';
import { root, python, run } from './tooling.mjs';
import { hashFile, within } from '../server/files.mjs';
import { download } from './download.mjs';
import { architecture } from '../server/platform.mjs';
import { prepareFonts } from './prepare-fonts.mjs';
import { checkWebAssets } from './check-web-assets.mjs';
const requestedArch = process.argv.find(x => x.startsWith('--arch='))?.slice(7) || 'all';
const targets = requestedArch === 'all' ? [architecture('x64'), architecture('arm64')] : [architecture(requestedArch)];
const host = process.argv.includes('--ugos') ? 'ugos' : 'fnos';
const product = { ...JSON.parse(await readFile(path.join(root, 'config/product.json'), 'utf8')), platform: targets.length === 2 ? 'all' : targets[0].fnos };
const iconRevision = createHash('sha256').update(await readFile(path.join(root, 'web/icon.png'))).digest('hex').slice(0, 16);
const out = path.join(root, host === 'ugos' ? 'public-ugos' : 'public'); await mkdir(out, { recursive: true });
await rm(path.join(out, 'icon.svg'), { force: true });
for (const file of ['index.html', 'style.css', 'ai-workspace.css', 'icon.png', 'auth-callback.html', 'privacy.html', 'terms.html']) await cp(path.join(root, 'web', file), path.join(out, file));
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
  if (host === 'ugos') throw new Error('Use scripts/build-ugos.mjs to package UPK');
  await prepareFonts();
  const directory = within(path.join(root, 'build'), path.join(root, 'build', `${product.appname}-${requestedArch}`));
  await rm(directory, { recursive: true, force: true });
  const app = path.join(directory, 'app'); await mkdir(app, { recursive: true });
  await cp(path.join(root, 'packaging'), directory, { recursive: true });
  for (const name of ['server', 'public', 'config', 'licenses', 'fonts']) await cp(path.join(root, name), path.join(app, name), { recursive: true, filter: file => !file.includes('__pycache__') && !/\.(?:bak|before)(?:$|[.\-_])/i.test(path.basename(file)) });
  await writeFile(path.join(app, 'config/product.json'), JSON.stringify(product, null, 2) + '\n');
  for (const name of ['README.md', 'NOTICE.md']) await cp(path.join(root, name), path.join(app, name));
  await cp(path.join(root, 'node_modules/ws'), path.join(app, 'node_modules/ws'), { recursive: true });
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: product.appname, version: product.version, type: 'module', private: true }));
  let components = 0;
  await run(python, [path.join(root, 'scripts/prepare-runtime-slim.py')]);
  const sharedPayload = path.join(app, 'payload/shared'); await mkdir(sharedPayload, { recursive: true });
  const copiedPayloads = new Set();
  for (const target of targets) {
  const lockName = target.node === 'arm64' ? 'runtime-lock-arm64.json' : 'runtime-lock.json';
  const slimLock = path.join(root, '.cache/runtime-slim', target.node, 'runtime-lock.json');
  const lock = JSON.parse(await readFile(slimLock, 'utf8'));
  if (lock.wechat || lock.packages.some(x => /wechat/i.test(x.name))) throw new Error('WeChat must never be bundled');
  const payload = path.join(app, 'payload', target.node); await mkdir(payload, { recursive: true });
  await cp(slimLock, path.join(payload, 'runtime-lock.json'));
  for (const entry of lock.packages) {
    if (!/^[a-zA-Z0-9_.+-]+$/.test(entry.file)) throw new Error('Invalid component filename');
    if (!/^[a-f0-9]{64}$/.test(entry.payloadSha256) || entry.payloadFile !== `${entry.payloadSha256}-data.tar.xz`) throw new Error('Invalid shared payload reference');
    const source = path.join(root, '.cache/runtime-slim/shared', entry.payloadFile);
    if (!copiedPayloads.has(entry.payloadFile)) {
      if (await hashFile(source) !== entry.payloadSha256) throw new Error(`Hash mismatch: ${entry.file}`);
      await cp(source, path.join(sharedPayload, entry.payloadFile)); copiedPayloads.add(entry.payloadFile);
    }
    components++;
  }
  }
  await cp(path.join(root, '.cache/runtime-slim/provenance.json'), path.join(app, 'payload/provenance.json'));
  const licenseRoot = path.join(app, 'licenses/npm'); await mkdir(licenseRoot, { recursive: true });
  for (const [name, license] of [['ws', 'LICENSE'], ['@novnc/novnc', 'LICENSE.txt'], ['@trimjs/web-app', 'package.json']]) {
    await mkdir(path.join(licenseRoot, name), { recursive: true });
    await cp(path.join(root, 'node_modules', name, license), path.join(licenseRoot, name, license));
  }
  const ui = path.join(app, 'ui'); await mkdir(path.join(ui, 'images'), { recursive: true });
  await writeFile(path.join(ui, 'config'), JSON.stringify({ '.url': { [`${product.appname}.Application`]: { title: product.displayName, icon: `images/qibox-${iconRevision}_{0}.png`, type: 'url', protocol: '', gatewayPrefix: product.gatewayPrefix, gatewaySocket: 'app.sock', url: `${product.gatewayPrefix}/`, allUsers: true } } }, null, 2));
  for (const pixels of [64, 256]) {
    const icon = await sharp(path.join(root, 'web/icon.png')).resize(pixels, pixels).png().toBuffer();
    await writeFile(path.join(ui, `images/qibox-${iconRevision}_${pixels}.png`), icon); await writeFile(path.join(directory, pixels === 64 ? 'ICON.PNG' : 'ICON_256.PNG'), icon);
  }
  const manifest = { appname: product.appname, version: product.version, display_name: product.displayName, desc: '在 NAS 上安装应用，支持微信多开和持续备份。', platform: product.platform, os_min_version: product.minOSVersion, source: 'thirdparty', maintainer: product.publisher, distributor: product.publisher, desktop_uidir: 'ui', desktop_applaunchname: `${product.appname}.Application`, install_dep_apps: 'nodejs_v22', ctl_stop: 'true', checkport: 'false', micro_app: 'true' };
  await writeFile(path.join(directory, 'manifest'), Object.entries(manifest).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  await mkdir(path.join(directory, 'wizard'), { recursive: true });
  for (const name of ['install_init', 'install_callback', 'config_init', 'config_callback', 'upgrade_callback', 'uninstall_callback']) await writeFile(path.join(directory, 'cmd', name), '#!/bin/bash\nexit 0\n');
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
