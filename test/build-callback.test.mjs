import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

test('generated lifecycle callback reports missing destination to fnOS and exits unsuccessfully', {skip:process.platform!=='linux'},async()=>{
 const source=await readFile(new URL('../scripts/build.mjs',import.meta.url),'utf8');
 const start=source.indexOf('`#!/bin/bash',source.indexOf("['install_callback', 'upgrade_callback']"));
 const end=source.indexOf('`);',start);
 const callback=Function('name',`return ${source.slice(start,end+1)};`)('install_callback');
 const folder=await mkdtemp(path.join(os.tmpdir(),'qibox-callback-test-'));
 try{
  const script=path.join(folder,'callback'),log=path.join(folder,'error.log');await writeFile(script,callback);
  const env={...process.env,TRIM_TEMP_LOGFILE:log};delete env.TRIM_APPDEST;
  const result=spawnSync('/bin/bash',[script],{env,encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(await readFile(log,'utf8'),/TRIM_APPDEST.*required/);assert.match(result.stderr,/TRIM_APPDEST/);
 }finally{await rm(folder,{recursive:true,force:true})}
});
