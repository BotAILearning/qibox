import { AppError } from './files.mjs';
import path from 'node:path';
import { access } from 'node:fs/promises';

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
export const runtimeLibraries = (root, arch = process.arch) => `${root}/usr/lib/${architecture(arch).triple}:${root}/lib/${architecture(arch).triple}:${root}/usr/lib`;
export async function runtimePayload(appRoot, arch = process.arch) {
  const target = architecture(arch);
  const directory = path.join(appRoot, 'payload', target.node);
  try { await access(path.join(directory, 'runtime-lock.json')); return directory; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return path.join(appRoot, 'payload'); // Compatibility with older FPK layouts.
}
export function runtimeArchive(appRoot, payloadRoot, entry) {
  if (entry.payloadFile !== undefined || entry.payloadSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(entry.payloadSha256) || entry.payloadFile !== `${entry.payloadSha256}-data.tar.xz`) throw new Error('Invalid shared runtime payload');
    return { filename: path.join(appRoot, 'payload/shared', entry.payloadFile), sha256: entry.payloadSha256 };
  }
  if (!/^[a-zA-Z0-9_.+-]+$/.test(entry.file)) throw new Error('Invalid runtime payload name');
  return { filename: path.join(payloadRoot, entry.file), sha256: entry.sha256 };
}
export function runtimeArchives(lock) {
  if (lock.payloadFormat === 3) {
    if (!Array.isArray(lock.archives) || !lock.archives.length ||
        lock.archives.some(entry => !/^[a-f0-9]{64}$/.test(entry.payloadSha256) ||
          entry.payloadFile !== `${entry.payloadSha256}-data.tar.xz`) ||
        new Set(lock.archives.map(entry => entry.payloadFile)).size !== lock.archives.length) {
      throw new Error('Invalid consolidated runtime archives');
    }
    return lock.archives;
  }
  if (lock.payloadFormat !== undefined && lock.payloadFormat !== 2) throw new Error('Unsupported runtime payload format');
  if (!Array.isArray(lock.packages) || !lock.packages.length) throw new Error('Missing runtime packages');
  return lock.packages;
}
export function platformConfig(env = process.env) {
  return { host: 'fnos', appRoot: env.TRIM_APPDEST, dataRoot: env.TRIM_PKGVAR, prefix: '/app/qibox', nasPicker: true };
}
export function validUserKey(uid, { host = 'fnos', dev = false } = {}) {
  return host === 'fnos' && typeof uid === 'string' && (/^\d+$/.test(uid) || dev && uid === 'development');
}
export function gatewayIdentity(req, host = 'fnos') {
  if (host !== 'fnos') throw new AppError('当前平台不受支持', 403);
  if (req.socket.remoteAddress) throw new AppError('请从飞牛应用入口访问', 403);
  const uid = req.headers['x-trim-userid'];
  if (typeof uid !== 'string' || !/^\d+$/.test(uid)) throw new AppError('请重新登录飞牛', 401);
  return { uid, username: req.headers['x-trim-username'] || '', isAdmin: req.headers['x-trim-isadmin'] === 'true' };
}
