import path from 'node:path';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { root, run, python } from './tooling.mjs';
import { download } from './download.mjs';
import { architecture } from '../server/platform.mjs';
import { hashFile, within } from '../server/files.mjs';
import { prepareFonts } from './prepare-fonts.mjs';

const product = JSON.parse(await readFile(path.join(root, 'config/product.json')));
await prepareFonts();
await run(process.execPath, ['scripts/build.mjs', '--ui-only', '--ugos']);
const project = within(path.join(root, 'build'), path.join(root, 'build', 'qibox-ugos'));
await rm(project, { recursive: true, force: true }); await mkdir(project, { recursive: true });
const common = path.join(project, 'rootfs_common'); await mkdir(common);
for (const name of ['server', 'config', 'licenses', 'fonts', 'native']) await cp(path.join(root, name), path.join(common, name), { recursive: true, filter: file => !file.includes('__pycache__') });
for (const [name, license] of [['ws', 'LICENSE'], ['@novnc/novnc', 'LICENSE.txt'], ['@ugreen-nas/core', 'package.json']]) {
  const destination = path.join(common, 'licenses/npm', name); await mkdir(destination, { recursive: true });
  await cp(path.join(root, 'node_modules', name, license), path.join(destination, license));
}
await cp(path.join(root, 'public-ugos'), path.join(common, 'www'), { recursive: true });
await cp(path.join(root, 'public-ugos'), path.join(common, 'public'), { recursive: true });
await cp(path.join(root, 'node_modules/ws'), path.join(common, 'node_modules/ws'), { recursive: true });
await writeFile(path.join(common, 'package.json'), JSON.stringify({ name: product.appname, version: product.version, type: 'module', private: true }));
await writeFile(path.join(common, 'www/version.json'), JSON.stringify({ version: product.version }));
for (const name of ['README.md', 'NOTICE.md']) await cp(path.join(root, name), path.join(common, name));
const sourceIcon = path.join(root, 'web/icon.png');
const { data: pixels, info: iconInfo } = await sharp(sourceIcon).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const corners = [0, iconInfo.width - 1, (iconInfo.height - 1) * iconInfo.width, iconInfo.height * iconInfo.width - 1];
if (!corners.every(index => pixels[index * 4 + 3] === 0)) throw new Error('UGOS icon must have transparent corners');
await sharp(sourceIcon).resize(256, 256).png().toFile(path.join(common, 'icon.png'));
await writeFile(path.join(project, 'project.yaml'), `spec_version: "2.1"
app_id: com.bot.qibox
version: ${product.version}
support_arch: [amd64, arm64]
product_series: [nasync]
supports: [pc, app]
start_cmd: bin/node /var/packages/com.bot.qibox/server/ugos-entry.mjs
port: 28790
depend_fw_version: 1.13.0.0000
proxy_path: api/qibox
open_type: inner
tag_types: [utility, backup]
support_migration: true
allow_add_access_path: false
only_admin: false
permissions:
  - SYSTEM.EXEC_SYSTEM_COMMAND
  - NETWORK.ACCESS_INTERNET
i18n:
  zh-CN:
    name: 栖盒
    description: 精选应用与个人桌面，支持官方微信多开和持续备份。
    author: Bot
    publisher: Bot
  en-US:
    name: Qibox
    description: Selected apps and a personal desktop for official WeChat on your NAS.
    author: Bot
    publisher: Bot
`);
const nodes = {
  x64: 'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307',
  arm64: 'fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8',
};
const inventory = [];
const nativeLock = JSON.parse(await readFile(path.join(root, 'config/ugos-bootstrap-lock.json')));
if (await hashFile(path.join(root, 'native/ugos-namespace.c')) !== nativeLock.sourceSha256) throw new Error('Rebuild the native helper after source changes');
for (const arch of ['x64', 'arm64']) {
  const target = architecture(arch), folder = path.join(project, `rootfs_${target.deb}`), payload = path.join(folder, 'payload');
  await mkdir(payload, { recursive: true });
  const lock = JSON.parse(await readFile(path.join(root, 'config', arch === 'arm64' ? 'runtime-lock-arm64.json' : 'runtime-lock.json')));
  await writeFile(path.join(payload, 'runtime-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  for (const entry of lock.packages) {
    const source = path.join(root, arch === 'arm64' ? '.cache/runtime-arm64' : '.cache/runtime', entry.file);
    if (await hashFile(source) !== entry.sha256) throw new Error(`Runtime hash mismatch: ${entry.name}`);
    await cp(source, path.join(payload, entry.file));
  }
  const name = `node-v22.23.2-linux-${arch}.tar.xz`, archive = path.join(root, '.cache/tools', name);
  await download(`https://nodejs.org/dist/v22.23.2/${name}`, archive, nodes[arch]);
  await run(python, ['scripts/prepare-node.py', archive, path.join(folder, 'bin'), String(target.elf)]);
  const helper = path.join(root, '.cache/ugos-bootstrap', target.deb, 'qibox-native');
  if (await hashFile(helper) !== nativeLock.targets[target.deb].sha256) throw new Error('Native helper hash mismatch');
  await cp(helper, path.join(folder, 'bin/qibox-native'));
  inventory.push({ arch, runtimeComponents: lock.packages.length, nodeVersion: '22.23.2', nodeArchiveSha256: nodes[arch] });
}
const tool = path.join(root, '.cache/tools/ugcli.exe');
await download('https://osswaf.ugnas.com/pro/ugcli/download/ugcli-v1.1.0.25-windows-amd64.exe', tool);
await download('https://osswaf.ugnas.com/pro/ugcli/download/ugcli-v1.1.0.25-linux-amd64', path.join(project, 'ugcli-linux'));
await run(tool, ['check'], { cwd: project });
await writeFile(path.join(root, 'reports/ugos-build-inputs.json'), JSON.stringify({ version: product.version, appId: 'com.bot.qibox', inventory }, null, 2));
console.log(`UGOS inputs ready: ${project}. Pack with official ugcli pack --arch arm64 --build 1, then run scripts/verify-upk.py on the result.`);
