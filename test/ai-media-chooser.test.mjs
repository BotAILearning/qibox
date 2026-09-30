import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FileChooser } from '../server/file-chooser.mjs';
import { temp, cleanup } from './fixtures.mjs';
const file = {name:'AI-generated-00000000-0000-4000-8000-000000000000.mp3',type:'audio/mpeg',data:Buffer.from('generated test audio').toString('base64')};
async function setup(t) {
 const root=await temp(), sent=[], chooser=new FileChooser({dataRoot:root,send:event=>sent.push(event)});
 await chooser.init();t.after(async()=>{await chooser.close();await cleanup(root);});return {chooser,sent};
}
test('generated audio fills exactly one new portal request, hides its selection and retains exact bytes', async t=>{
 const {chooser,sent}=await setup(t), lease=chooser.armGeneratedMedia(file), id=randomUUID();
 chooser.receive({type:'request',id,multiple:true});assert.equal(chooser.state(randomUUID()).request,null);
 await lease.done;assert.equal(sent.length,1);assert.equal(sent[0].id,id);assert.equal(sent[0].response,0);
 assert.deepEqual(await readFile(fileURLToPath(sent[0].uris[0])),Buffer.from(file.data,'base64'));
 const other=randomUUID();chooser.receive({type:'request',id:other,multiple:false});await lease.close();
 assert.equal(chooser.state().request.id,other);assert.equal(sent.length,1);
});
test('an existing user file chooser, file export or another media lease blocks generated audio',async t=>{
 for(const busy of ['chooser','export','lease']) {
  const {chooser}=await setup(t);let lease;
  if(busy==='chooser')chooser.receive({type:'request',id:randomUUID(),multiple:false});
  if(busy==='export')chooser.exports.pending={id:randomUUID()};
  if(busy==='lease')lease=chooser.armGeneratedMedia(file);
  assert.throws(()=>chooser.armGeneratedMedia(file),/正在选择文件/);
  if(busy==='export')chooser.exports.pending=null;
  await lease?.close();
 }
});
test('cancelling a media reservation cannot consume a later user request',async t=>{
 const {chooser,sent}=await setup(t), controller=new AbortController(),lease=chooser.armGeneratedMedia(file,{signal:controller.signal});
 controller.abort();await lease.close();const id=randomUUID();chooser.receive({type:'request',id,multiple:false});
 assert.equal(chooser.state().request.id,id);assert.equal(chooser.pending.client,null);assert.deepEqual(sent,[]);
});
test('aborting generated upload cancels only its owned request and does not return a file URI',async t=>{
 const {chooser,sent}=await setup(t),controller=new AbortController(),lease=chooser.armGeneratedMedia(file,{signal:controller.signal});
 const id=randomUUID();chooser.receive({type:'request',id,multiple:true});controller.abort();await lease.close();
 assert.equal(chooser.pending,null);assert.equal(sent.length,1);assert.deepEqual(sent[0],{id,response:1});
});
