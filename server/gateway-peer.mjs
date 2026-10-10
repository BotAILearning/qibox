import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {AppError} from './files.mjs';

const helper=fileURLToPath(new URL('./gateway-peer.py',import.meta.url));
const denied=()=>new AppError('请从飞牛应用入口访问',403,'gateway_peer_untrusted');
export function nativeGatewayPeer(socket,{launch=spawn,timeoutMs=5000}={}) {
 return new Promise((resolve,reject)=>{
  let child,timer,output='',finished=false;
  const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(value);};
  try { child=launch('/usr/bin/python3',[helper],{stdio:['ignore','pipe','ignore',socket],windowsHide:true}); }
  catch { finish(denied());return; }
  child.once('error',()=>finish(denied()));
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1024){child.kill();finish(denied());}});
  child.once('close',code=>{
   if(code!==0){finish(denied());return;}
   try {const value=JSON.parse(output);if(!Number.isSafeInteger(value.uid)||value.uid<0||value.uid>2147483647)throw Error();finish(null,value.uid);}catch{finish(denied());}
  });
  timer=setTimeout(()=>{child.kill();finish(denied());},timeoutMs);
 });
}
export function gatewayPeerVerifier({platform=process.platform,ownerUid=process.getuid?.(),peerUid=nativeGatewayPeer,passwd=()=>readFile('/etc/passwd','utf8')}={}) {
 const checked=new WeakMap();let worker;
 const workerUid=()=>worker??=(async()=>{
  const row=(await passwd()).split('\n').find(line=>line.startsWith('www-data:'));
  const uid=row?.split(':')[2];if(!uid||!/^\d+$/.test(uid))throw denied();return Number(uid);
 })();
 return async socket=>{
  if(socket.remoteAddress)throw denied();
  // Linux is the production target; named pipes in local Windows tests have
  // no SO_PEERCRED. Production Unix peers always use the kernel check below.
  if(platform!=='linux')return;
  if(!checked.has(socket))checked.set(socket,(async()=>{
   const uid=await peerUid(socket);
   if(uid!==0&&uid!==ownerUid&&uid!==await workerUid())throw denied();
  })());
  await checked.get(socket);
 };
}
