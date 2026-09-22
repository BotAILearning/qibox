import path from 'node:path';
import { userInfo } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { architecture } from './platform.mjs';

export async function nativeIdentity({ session, home, runtimeRoot, uid = process.getuid(), gid = process.getgid(), lookup = userInfo }) {
  try { lookup(); return {}; } catch (error) { if (error.code !== 'ERR_SYSTEM_ERROR' && error.code !== 'ENOENT') throw error; }
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 0 || /[:\r\n]/.test(home)) throw new Error('Invalid native account');
  const passwd = path.join(session, 'passwd'), group = path.join(session, 'group');
  // UGOS omits /etc/passwd. Supply the actual unprivileged UID/GID only to this
  // instance's children; neither host accounts nor process credentials change.
  await writeFile(passwd, `qibox:x:${uid}:${gid}::${home}:/bin/false\n`, { mode: 0o600 });
  await writeFile(group, `qibox:x:${gid}:\n`, { mode: 0o600 });
  return { USER: 'qibox', LOGNAME: 'qibox', LD_PRELOAD: path.join(runtimeRoot, 'usr/lib', architecture().triple, 'libnss_wrapper.so'), NSS_WRAPPER_PASSWD: passwd, NSS_WRAPPER_GROUP: group };
}
