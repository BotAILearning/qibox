import path from 'node:path';
import { access, mkdir, rm, link, symlink } from 'node:fs/promises';

export async function wechatLibraryPath(applicationRoot, session, base, triple) {
  // Radium's libffmpeg.so shadows VLC's incompatible library. Never expose
  // that whole directory globally. The call SDK still needs libtxffmpeg.so,
  // which has no component-local search path of its own.
  const sdk = path.join(session, 'wechat-sdk-libraries');
  await rm(sdk, { recursive: true, force: true });
  await mkdir(sdk, { mode: 0o700 });
  const dependency = path.join(applicationRoot, 'opt/wechat/RadiumWMPF/runtime/libtxffmpeg.so');
  try { await access(dependency); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return `${path.join(applicationRoot, 'opt/wechat')}:${base}:/lib/${triple}/pulseaudio`; }
  const target = path.join(sdk, 'libtxffmpeg.so');
  try { await link(dependency, target); }
  catch (error) { if (error.code !== 'EXDEV') throw error; await symlink(dependency, target); }
  return `${path.join(applicationRoot, 'opt/wechat')}:${sdk}:${base}:/lib/${triple}/pulseaudio`;
}
