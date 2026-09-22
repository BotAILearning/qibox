import path from 'node:path';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { root, run } from './tooling.mjs';
import { hashFile } from '../server/files.mjs';

// Install the pinned official Zig archive before running this build. The same
// compiler can cross-compile both Linux architectures without target sysroots.
const compiler = process.env.QIBOX_ZIG || path.join(root, '.cache/tools/zig-x86_64-windows-0.14.1/zig.exe');
const source = path.join(root, 'native/ugos-namespace.c');
const report = { compiler: 'Zig 0.14.1', windowsArchiveSha256: '554f5378228923ffd558eac35e21af020c73789d87afeabf4bfd16f2e6feed2c', sourceSha256: await hashFile(source), targets: {} };
for (const [arch, target, elf] of [['amd64', 'x86_64-linux-musl', 62], ['arm64', 'aarch64-linux-musl', 183]]) {
  const directory = path.join(root, '.cache/ugos-bootstrap', arch); await mkdir(directory, { recursive: true });
  const output = path.join(directory, 'qibox-native');
  await run(compiler, ['cc', '-target', target, '-O2', '-static', '-s', '-Wall', '-Wextra', '-Werror', source, '-o', output]);
  const bytes = await readFile(output);
  if (bytes.readUInt32BE(0) !== 0x7f454c46 || bytes.readUInt16LE(18) !== elf) throw new Error('Wrong native helper architecture');
  report.targets[arch] = { target, elf, sha256: await hashFile(output), bytes: bytes.length };
}
await mkdir(path.join(root, 'licenses/ugos-native'), { recursive: true });
await cp(path.join(path.dirname(compiler), 'lib/libc/musl/COPYRIGHT'), path.join(root, 'licenses/ugos-native/MUSL-COPYRIGHT'));
await cp(path.join(path.dirname(compiler), 'LICENSE'), path.join(root, 'licenses/ugos-native/ZIG-LICENSE'));
await writeFile(path.join(root, 'config/ugos-bootstrap-lock.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
