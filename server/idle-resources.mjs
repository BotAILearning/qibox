import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Admission limits, not a claim to cap other NAS applications or all I/O.
export function idleResourceProbe(now = () => Date.now()) {
  let previous;
  return async limits => {
    if (process.platform !== 'linux') return { allowed: false, reason: '当前平台无法检测 NAS 资源负载' };
    try {
      const net = await readFile('/proc/net/dev', 'utf8');
      const bytes = net.split('\n').filter(line => line.includes(':') && !/^\s*lo:/.test(line)).reduce((sum, line) => {
        const fields = line.split(':')[1].trim().split(/\s+/).map(Number); return sum + fields[0] + fields[8];
      }, 0);
      const at = now(), networkMBps = previous && at > previous.at ? Math.max(0, bytes - previous.bytes) / ((at - previous.at) / 1000) / 1048576 : null;
      previous = { at, bytes };
      const loadPercent = os.loadavg()[0] / os.cpus().length * 100, freeMemoryMB = os.freemem() / 1048576;
      const reason = networkMBps === null ? '正在采样网络负载' : networkMBps > limits.networkMBps ? 'NAS 网络繁忙，闲时备份已退让' :
        loadPercent > limits.loadPercent ? 'NAS 系统负载较高，闲时备份已退让' : freeMemoryMB < limits.freeMemoryMB ? 'NAS 可用内存不足，闲时备份已退让' : '';
      return { allowed: !reason, reason, loadPercent: Math.round(loadPercent), freeMemoryMB: Math.floor(freeMemoryMB), networkMBps: networkMBps === null ? null : Math.round(networkMBps * 100) / 100 };
    } catch { return { allowed: false, reason: '暂时无法检测 NAS 负载，等待下次检查' }; }
  };
}
function command(bin, args) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(false)); child.once('exit', code => resolve(code === 0));
  });
}
export async function idlePriority(runtime) {
  const pid = runtime.processes?.find(item => item.name === 'wechat')?.process?.pid;
  if (!Number.isInteger(pid)) return false;
  // Affects the owned official client and its existing children only.
  let rows;
  try { rows = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'); } catch { rows = ''; }
  const ids = [pid, ...rows.trim().split(/\s+/).map(Number).filter(value => value > 0)];
  const results = await Promise.all(ids.map(async id => (await command('renice', ['-n','10','-p',String(id)])) && (await command('ionice', ['-c','3','-p',String(id)]))));
  return results.every(Boolean);
}
