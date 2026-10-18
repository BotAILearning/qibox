import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {createApplication} from '../server/index.mjs';
import {root} from '../scripts/tooling.mjs';
import {temp,cleanup,runtimeFactory,fetcher,extractor,packageSha256} from './fixtures.mjs';

test('NAS preparation checks remain in the background while session and saved state stay responsive',async()=>{
 const dataRoot=await temp();let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const id='11111111-1111-4111-8111-111111111111',user=path.join(dataRoot,'users/development');
 await mkdir(path.join(user,'instances',id),{recursive:true});
 await writeFile(path.join(user,'instances.json'),JSON.stringify([{id,appId:'wechat',name:'已有微信'}]));
 await writeFile(path.join(user,'consent.json'),JSON.stringify({accepted:true}));
 await writeFile(path.join(user,'instances',id,'schedule.json'),JSON.stringify({mode:'idle',startTime:'02:00',endTime:'02:30'}));
 const preparation={manifest:{identity:'verified-later'},state:{status:'ready'},init:()=>gate,snapshot(){return {...this.state};},close:async()=>{}};
 const app=await createApplication({appRoot:root,dataRoot,dev:true,deferRestore:true,runtimeFactory,fetcher,extract:extractor,trustedHashes:[packageSha256],preparationFactory:()=>preparation});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}${app.prefix}`;
 const headers={cookie:`qibox_dev=${app.devKey}`};
 try{
  const session=await fetch(base+'/api/session',{headers,signal:AbortSignal.timeout(1000)}).then(r=>r.json());
  assert.equal(session.consent.accepted,true);
  const state=await fetch(base+'/api/state',{headers,signal:AbortSignal.timeout(1000)}).then(r=>r.json());
  assert.equal(state.preparation.status,'working','an old ready flag must stay hidden until startup verification completes');
  assert.equal(state.instances[0].runtime.status,'preparing');assert.equal(state.instances[0].runtime.aiEntryAvailable,false);
  assert.equal(state.instances[0].schedule.mode,'idle');assert.equal(state.instances[0].name,'已有微信');
  const denied=await fetch(base+'/api/preparation',{method:'POST',headers:{...headers,'x-csrf-token':session.csrf,'content-type':'application/json'},body:JSON.stringify({action:'start'})});
  assert.equal(denied.status,409);
  release();await app.startRecovery();
 }finally{release();await app.close();await cleanup(dataRoot);}
});
