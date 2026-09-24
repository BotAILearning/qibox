import { AppError } from './files.mjs';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const targets = {
  x64: { node: 'x64', deb: 'amd64', fnos: 'x86', label: 'x86_64', triple: 'x86_64-linux-gnu', elf: 62 },
  arm64: { node: 'arm64', deb: 'arm64', fnos: 'arm', label: 'ARM64', triple: 'aarch64-linux-gnu', elf: 183 },
};
export function architecture(value = process.arch) {
  const target = targets[value];
  if (!target) throw new AppError('需要使用 x86_64 或 ARM64 设备', 409);
  return target;
}
export const officialWechatUrl = arch => `https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_${architecture(arch).node === 'arm64' ? 'arm64' : 'x86_64'}.deb`;
export const runtimeLibraries = (root, arch = process.arch) => `${root}/usr/lib/${architecture(arch).triple}:${root}/lib/${architecture(arch).triple}:${root}/usr/lib/${architecture(arch).triple}/pulseaudio:${root}/usr/lib`;
export async function runtimePayload(appRoot, arch = process.arch) {
  const target = architecture(arch);
  const directory = path.join(appRoot, 'payload', target.node);
  try { await access(path.join(directory, 'runtime-lock.json')); return directory; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return path.join(appRoot, 'payload'); // Architecture-specific UPK and older FPK.
}
export function runtimeArchive(appRoot, payloadRoot, entry) {
  if (entry.payloadFile !== undefined || entry.payloadSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(entry.payloadSha256) || entry.payloadFile !== `${entry.payloadSha256}-data.tar.xz`) throw new Error('Invalid shared runtime payload');
    return { filename: path.join(appRoot, 'payload/shared', entry.payloadFile), sha256: entry.payloadSha256 };
  }
  if (!/^[a-zA-Z0-9_.+-]+$/.test(entry.file)) throw new Error('Invalid runtime payload name');
  return { filename: path.join(payloadRoot, entry.file), sha256: entry.sha256 };
}
export function platformConfig(env = process.env) {
  if (env.UGAPP_INSTALL_DIR) return { host: 'ugos', appRoot: env.UGAPP_INSTALL_DIR, dataRoot: env.UGAPP_DATA_DIR, prefix: '/api/qibox', port: 28790, nasPicker: false };
  return { host: 'fnos', appRoot: env.TRIM_APPDEST, dataRoot: env.TRIM_PKGVAR, prefix: '/app/qibox', nasPicker: true };
}
export function validUserKey(uid, { host = 'fnos', dev = false } = {}) {
  return typeof uid === 'string' && (/^\d+$/.test(uid) || host === 'ugos' && /^ugos-[a-f0-9]{64}$/.test(uid) || dev && uid === 'development');
}
export function gatewayIdentity(req, host = 'fnos') {
  if (host === 'ugos') {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw new AppError('请从绿联应用入口访问', 403);
    const accountId = req.headers['ugreen-user-id'], kind = req.headers['ugreen-user-type'];
    if (typeof accountId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(accountId)) {
      throw new AppError('请重新登录绿联后打开栖盒', 401, accountId == null || accountId === '' ? 'UGOS_USER_ID_MISSING' : 'UGOS_USER_ID_INVALID');
    }
    // UGOS 1.19.1 on DH4300 Plus authenticates the account but omits the role.
    // A verified account can use its own apps; only an explicit admin role
    // permits shared-package administration. Never infer admin from a UID.
    if (kind !== undefined && !['admin', 'users'].includes(kind)) throw new AppError('请重新登录绿联后打开栖盒', 401, 'UGOS_USER_TYPE_INVALID');
    // UGOS account IDs are identifiers, not necessarily POSIX numeric UIDs.
    // Keep existing numeric directories; hash opaque IDs without case folding
    // so they remain distinct and safe on both Linux and Windows filesystems.
    const uid = /^\d{1,128}$/.test(accountId) ? accountId : `ugos-${createHash('sha256').update(accountId).digest('hex')}`;
    return { uid, username: req.headers['ugreen-user-name'] || '', isAdmin: kind === 'admin' };
  }
  if (req.socket.remoteAddress) throw new AppError('请从飞牛应用入口访问', 403);
  const uid = req.headers['x-trim-userid'];
  if (typeof uid !== 'string' || !/^\d+$/.test(uid)) throw new AppError('请重新登录飞牛', 401);
  return { uid, username: req.headers['x-trim-username'] || '', isAdmin: req.headers['x-trim-isadmin'] === 'true' };
}
