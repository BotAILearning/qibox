import assert from 'node:assert/strict';
import test from 'node:test';
import {protectGatewaySocket} from '../server/gateway-socket.mjs';

const socketPath='/owned-app/app.sock';
function fixture({socket=true,uid=123,failure}={}) {
 const events=[],mode={value:0o666};
 return {events,mode,options:{ownerUid:123,inspect:async()=>({isSocket:()=>socket,uid}),setMode:async(path,value)=>{assert.equal(path,socketPath);mode.value=value;events.push({mode:value});},run:async(binary,args,options)=>{assert.equal(binary,'/usr/bin/setfacl');assert.equal(options.timeout,5000);assert.equal(options.maxBuffer,65536);events.push({args});if(failure)throw failure;}}};
}
test('gateway transport restricts the socket to its owner and the explicit platform worker',async()=>{
 const f=fixture();await protectGatewaySocket(socketPath,f.options);
 assert.deepEqual(f.events,[{mode:0o600},{args:['--remove-all',socketPath]},{args:['--modify','user:www-data:rw-',socketPath]}]);
 assert.equal(f.mode.value,0o600,'the ACL grants only the named worker, never other users');
});
test('ACL setup failure leaves owner-only access and never opens the socket to everyone',async()=>{
 const f=fixture({failure:new Error('platform ACL unavailable')});
 await assert.rejects(protectGatewaySocket(socketPath,f.options),/无法安全设置飞牛统一网关权限/);
 assert.equal(f.mode.value,0o600);assert.equal(f.events.some(e=>e.mode===0o666),false);
 assert.equal(f.events.filter(e=>e.args).length,1,'a failed removal must not be followed by a grant');
});
test('a regular file or another owner is not chmodded or granted access',async()=>{
 for(const f of [fixture({socket:false}),fixture({uid:456})]){
  await assert.rejects(protectGatewaySocket(socketPath,f.options),/类型或所属用户不正确/);
  assert.deepEqual(f.events,[]);
 }
});
