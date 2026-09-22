import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './files.mjs';
export function validateClipboard(text) {
  if (typeof text !== 'string' || !text || text.includes('\0') || Buffer.byteLength(text) > 60000) throw new AppError('请粘贴不超过 60 KB 的文字');
  return text;
}
export function validateClipboardFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 10) throw new AppError('一次最多粘贴 10 个文件');
  let size = 0;
  const names = new Set();
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 180 || Buffer.byteLength(file.name) > 255 || /[\\/\x00-\x1f\x7f]/.test(file.name) || ['.','..'].includes(file.name) || names.has(file.name)) throw new AppError('文件名称无效或重复');
    names.add(file.name);
    if (typeof file.data !== 'string' || file.data.length > 28 * 1024 * 1024 || file.data.length % 4 || Buffer.from(file.data, 'base64').toString('base64') !== file.data) throw new AppError('文件内容无效');
    size += Buffer.byteLength(file.data, 'base64');
    if (size > 20 * 1024 * 1024) throw new AppError('粘贴文件合计不能超过 20 MB');
    if (typeof file.type !== 'string' || file.type.length > 100) throw new AppError('文件类型无效');
  }
  return files;
}
export async function ownClipboard({ text, files, env, appRoot, runtimeRoot, previous }) {
  if (files) validateClipboardFiles(files); else validateClipboard(text);
  // A bundled interpreter and bundled GTK keep this independent of host packages.
  const child = spawn(path.join(runtimeRoot, 'usr/bin/python3.11'), [path.join(appRoot, files ? 'server/clipboard-files.py' : 'server/clipboard.py')], {
    env: { ...env, PYTHONHOME: path.join(runtimeRoot, 'usr'), PYTHONNOUSERSITE: '1' }, stdio: ['pipe', 'pipe', 'ignore'], detached: true,
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new AppError('粘贴未完成，请重试', 504)); }, 5000);
      let output = '';
      const fail = () => { clearTimeout(timer); reject(new AppError('粘贴未完成，请重试', 500)); };
      child.once('error', fail); child.once('exit', fail); child.stdin.on('error', fail);
      child.stdout.on('data', bytes => { output += bytes.toString(); if (output.includes('ready\n')) { clearTimeout(timer); resolve(); } });
      child.stdin.end(files ? JSON.stringify(files.map(({name,type,data}) => ({name,type,data}))) : text);
    });
    previous?.kill();
    return child;
  } catch (error) { child.kill(); throw error; }
}
