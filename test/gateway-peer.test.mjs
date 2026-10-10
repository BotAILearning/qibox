import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {gatewayPeerVerifier,nativeGatewayPeer} from '../server/gateway-peer.mjs';

const passwd=async()=> 'root:x:0:0::/:/bin/sh\nwww-data:x:712:712::/:/bin/sh\n';
test('production Unix identity requires the kernel peer, never a claimed user or admin header',async()=>{
 for(const uid of [1001,65534]){
  const verify=gatewayPeerVerifier({platform:'linux',ownerUid:996,passwd,peerUid:async()=>uid});
  await assert.rejects(verify({headers:{'x-trim-userid':'1000','x-trim-isadmin':'true'}}),e=>e.status===403&&e.code==='gateway_peer_untrusted');
 }
 for(const uid of [0,996,712])await gatewayPeerVerifier({platform:'linux',ownerUid:996,passwd,peerUid:async()=>uid})({});
});
test('a connection checks its peer once, including concurrent requests and denied retries',async()=>{
 for(const uid of [712,1001]){
  let calls=0;const socket={},verify=gatewayPeerVerifier({platform:'linux',ownerUid:996,passwd,peerUid:async()=>{calls++;return uid;}});
  const results=await Promise.allSettled([verify(socket),verify(socket),verify(socket)]);
  assert.equal(calls,1);assert.ok(results.every(r=>r.status===(uid===712?'fulfilled':'rejected')));
 }
});
test('TCP requests are rejected without launching the native peer helper',async()=>{
 let calls=0;const verify=gatewayPeerVerifier({platform:'linux',ownerUid:996,passwd,peerUid:async()=>{calls++;return 0;}});
 await assert.rejects(verify({remoteAddress:'127.0.0.1'}),e=>e.status===403);assert.equal(calls,0);
});
test('missing worker or native credential failure stays closed',async()=>{
 await assert.rejects(gatewayPeerVerifier({platform:'linux',ownerUid:996,passwd:async()=>'',peerUid:async()=>1001})({}),e=>e.status===403);
 await assert.rejects(gatewayPeerVerifier({platform:'linux',ownerUid:996,passwd,peerUid:async()=>{throw Error('native failure');}})({}),/native failure/);
});
test('the inherited connection is used only for a bounded kernel lookup',async()=>{
 const socket={};let launched;
 const launch=(binary,args,options)=>{
  launched={binary,args,options};const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{};
  queueMicrotask(()=>{child.stdout.write('{"uid":712}');child.emit('close',0);});return child;
 };
 assert.equal(await nativeGatewayPeer(socket,{launch}),712);assert.equal(launched.binary,'/usr/bin/python3');
 assert.deepEqual(launched.options.stdio,['ignore','pipe','ignore',socket]);assert.ok(launched.args[0].endsWith('gateway-peer.py'));
});
test('malformed native output and timeout cannot authorize a connection',async()=>{
 for(const text of ['{}','{"uid":"712"}','{"uid":-1}','{"uid":1.5}']){
  const launch=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{};queueMicrotask(()=>{child.stdout.write(text);child.emit('close',0);});return child;};
  await assert.rejects(nativeGatewayPeer({},{launch}),e=>e.status===403);
 }
 let killed=false;const launch=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{killed=true;};return child;};
 await assert.rejects(nativeGatewayPeer({},{launch,timeoutMs:10}),e=>e.status===403);assert.equal(killed,true);
});
