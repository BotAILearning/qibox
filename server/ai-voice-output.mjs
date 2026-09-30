import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, lstat, realpath, unlink } from 'node:fs/promises';
import { ensureAudio } from './audio.mjs';
import { validateClipboardFiles } from './clipboard.mjs';
import { AppError } from './files.mjs';

// The generated MP3 stays inside this instance's private session. The native
// helper decodes it into the owned microphone; it is never attached as a file.
export async function stageNativeVoice(runtime, file, signal) {
  validateClipboardFiles([file]);
  if (file.type !== 'audio/mpeg' || !/^(?:AI-generated|AI合成)-[a-f0-9-]{36}\.mp3$/.test(file.name)) throw new AppError('合成语音内容无效');
  signal?.throwIfAborted(); await ensureAudio(runtime); signal?.throwIfAborted();
  if (!runtime.audioVoiceReady || !runtime.desktopEnv?.XDG_RUNTIME_DIR) throw new AppError('微信原生语音暂不可用，请重新打开该微信');
  const directory = path.join(runtime.desktopEnv.XDG_RUNTIME_DIR, 'audio', 'generated');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== path.resolve(directory)) throw new AppError('语音目录状态已变化');
  const target = path.join(directory, file.name), bytes = Buffer.from(file.data, 'base64');
  await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
  const stamp = await lstat(target);
  const close = async () => {
    const current = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current?.isFile() && current.dev === stamp.dev && current.ino === stamp.ino) await unlink(target);
  };
  if (signal?.aborted) { await close(); signal.throwIfAborted(); }
  return { media: { name: file.name, type: file.type, delivery: 'voice', path: target, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, close };
}
