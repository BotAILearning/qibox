import {lstat,chmod} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const command=promisify(execFile);
// fnOS forwards authenticated requests through its www-data nginx workers.
// Ordinary NAS users must not connect directly and supply trusted UID headers.
export async function protectGatewaySocket(socketPath,{inspect=lstat,setMode=chmod,run=command,ownerUid=process.getuid?.()}={}) {
 const file=await inspect(socketPath);
 if(!file.isSocket()||(ownerUid!==undefined&&file.uid!==ownerUid))throw new Error('统一网关 Socket 类型或所属用户不正确');
 await setMode(socketPath,0o600);
 try {
  const options={timeout:5000,maxBuffer:65536};
  await run('/usr/bin/setfacl',['--remove-all',socketPath],options);
  await run('/usr/bin/setfacl',['--modify','user:www-data:rw-',socketPath],options);
 } catch(error) {
  // Keep owner-only access when the platform cannot establish the gateway ACL.
  await setMode(socketPath,0o600);
  throw new Error('无法安全设置飞牛统一网关权限，请检查系统 ACL 工具和 www-data 用户',{cause:error});
 }
}
