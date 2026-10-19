import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createApplication } from '../server/index.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher } from './fixtures.mjs';
const appRoot=path.resolve(import.meta.dirname,'..');
for (const deferRestore of [false,true]) test(`saved update holds precede application restore (deferRestore=${deferRestore})`, async()=>{
 const dataRoot=await temp(); let app;
 try {
  app=await createApplication({appRoot,dataRoot,dev:true,runtimeFactory,extract:extractor,fetcher});
  const versions=path.join(dataRoot,'applications/wechat/versions','a'.repeat(64));await mkdir(path.join(versions,'opt/wechat'),{recursive:true});
  const current={version:'4.1.13.26',sha256:'a'.repeat(64),arch:'x64'};
  await writeFile(path.join(dataRoot,'applications/wechat/current.json'),JSON.stringify(current));app.library.current=current;
  const space=await app.users.get('development');await space.setConsent(true);
  const one=await space.add('one'),two=await space.add('two');await space.start(one.id);await space.start(two.id);
  const roots=[one,two].map(x=>path.join(dataRoot,'users/development/instances',x.id));
  await app.close();app=null;
  for(const root of roots){await writeFile(path.join(root,'session-resume.json'),JSON.stringify({resume:true,loggedIn:true}));await writeFile(path.join(root,'schedule.json'),JSON.stringify({mode:'continuous',startTime:'02:00',endTime:'02:30'}));await writeFile(path.join(root,'protected-test-secret'),'synthetic-secret');}
  const stateFile=path.join(dataRoot,'applications/wechat/manual-update/state.json');await mkdir(path.dirname(stateFile),{recursive:true});await writeFile(stateFile,JSON.stringify({holds:roots,state:{status:'complete',message:'updated'}}));
  let starts=0;
  app=await createApplication({appRoot,dataRoot,dev:true,deferRestore,runtimeFactory:(...args)=>{const r=runtimeFactory(...args),start=r.start;r.dataRoot=args[1].dataRoot;r.start=async()=>{starts++;return start.call(r)};return r;},extract:extractor,fetcher});
  if(deferRestore)await app.startRecovery();
  const restored=await app.users.get('development');await Promise.all([...restored.instances.values()].map(x=>x.scheduler.tick()));
  assert.equal(starts,0);assert.equal(app.library.updateHolds.size,2);
  await restored.start(one.id);assert.equal(starts,1);assert.equal(app.library.updateHolds.has(roots[0]),false);assert.equal(app.library.updateHolds.has(roots[1]),true);
  await restored.get(two.id).scheduler.tick();assert.equal(starts,1);
  for(const root of roots)assert.equal(await readFile(path.join(root,'protected-test-secret'),'utf8'),'synthetic-secret');
 }finally{await app?.close();await cleanup(dataRoot)}
});


