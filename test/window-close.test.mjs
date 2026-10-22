import test from 'node:test';import assert from 'node:assert/strict';import os from 'node:os';import path from 'node:path';import {mkdtemp,writeFile,rm,lstat} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {WindowClose,WindowCloseInput,desktopWindowConfig,closeRequestCommand} from '../server/window-close.mjs';
import {mayClaimFileRequest} from '../web/local-files.mjs';
import {desktopReconnect} from '../web/desktop-reconnect.mjs';
import {desktopStatus} from '../web/wechat-state.mjs';
import {setImmediate as yieldToPoll} from 'node:timers/promises';
async function fixture(t,perform){
  const root=await mkdtemp(path.join(os.tmpdir(),'qibox-window-'));
  const c=new WindowClose({dataRoot:root,perform});
  await c.init();await c.start(path.join(root,'window-close.request'));
  t.after(async()=>{c.dispose();await rm(root,{recursive:true,force:true});});
  return {c,root,signal:async()=>{
    const id=randomUUID();await writeFile(c.signalFile,id);
    // A timer-owned poll can make an explicit poll return early. Wait for its
    // action, then scan again if it checked before this signal was written.
    let exists;
    do{
      await c.poll();
      while(c.polling||c.busy)await yieldToPoll();
      exists=await lstat(c.signalFile).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
    }while(exists);
    return id;
  }};
}
test('native close asks once, cancel and stale ids cannot stop the instance',async t=>{let n=0;const {c,signal}=await fixture(t,async()=>n++);const id=await signal();assert.equal(c.state().windowCloseRequest.id,id);await signal();assert.equal(c.pending.id,id);await assert.rejects(c.resolve(randomUUID(),'quit'),/已结束/);await c.resolve(id,'cancel');assert.equal(n,0);assert.equal(c.pending,null);assert.equal(c.mode,'ask');});
test('remembered background is instance-local and survives restart',async t=>{const actions=[];const {c,root,signal}=await fixture(t,async a=>actions.push(a));const id=await signal();await c.resolve(id,'background',true);assert.deepEqual(actions,['background']);const reloaded=new WindowClose({dataRoot:root,perform:async a=>actions.push(a)});await reloaded.init();assert.equal(reloaded.mode,'background');await signal();assert.deepEqual(actions,['background','background']);await c.preference('ask');const next=await signal();assert.equal(c.pending.id,next);await assert.rejects(c.preference('kill-all'),/无效/);});
test('signal fixture waits for a timer-owned poll and its automatic action',async t=>{
  const actions=[],started=Promise.withResolvers(),release=Promise.withResolvers();
  const {c,signal}=await fixture(t,async action=>{started.resolve();await release.promise;actions.push(action);});
  await c.preference('background');
  // Inject the timer's winning poll deterministically, without relying on 300ms elapsed time.
  clearInterval(c.timer);
  const poll=c.poll.bind(c);let owner;
  c.poll=()=>{if(!owner)owner=poll();return poll();};
  let completed=false;
  const signalled=signal().then(id=>{completed=true;return id;});
  try{
    await started.promise;
    await yieldToPoll();
    assert.equal(completed,false,'the signal helper must not finish before the automatic action');
    assert.deepEqual(actions,[]);
  }finally{
    release.resolve();
    await owner;
    await signalled;
  }
  assert.deepEqual(actions,['background']);
  assert.equal(c.pending,null);
});
test('failed action keeps a retryable request; duplicate clients only execute once',async t=>{let fail=true,n=0,release;const gate=new Promise(r=>release=r);const {c,signal}=await fixture(t,async()=>{n++;if(fail)throw Error('offline');await gate;});const id=await signal();await assert.rejects(c.resolve(id,'background'),/offline/);assert.equal(c.pending.id,id);assert.match(c.pending.error,/未完成/);fail=false;const pending=c.resolve(id,'quit');await assert.rejects(c.resolve(id,'quit'),/已结束/);release();await pending;assert.equal(n,2);assert.equal(c.pending,null);});
test('restart while remembering cannot apply an old choice to a new process',async t=>{let n=0;const {c,signal}=await fixture(t,async()=>n++);const id=await signal();const saving=Promise.withResolvers();c.preference=()=>saving.promise;const choice=c.resolve(id,'quit',true);c.dispose();saving.resolve();await assert.rejects(choice,/已结束/);assert.equal(n,0);});
test('desktop binding intercepts main close only, retaining ordinary and detached controls',()=>{const defaults='<openbox_config><keyboard><keybind><action name="Close"/></keybind></keyboard><mouse><context name="Iconify"><action name="Iconify"/></context><context name="Close"><action name="Close"/></context></mouse><applications></applications></openbox_config>';const command=closeRequestCommand('/private a/usr/bin/python3.11','/app/close.py','/private a/window-close.request');const xml=desktopWindowConfig(defaults,command);assert.equal((xml.match(/name="If"/g)||[]).length,2);assert.match(xml,/<title type="exact">微信<\/title>/);assert.match(xml,/<else><action name="Close"\/><\/else>/);assert.match(xml,/name="Iconify"/);assert.match(xml,/PYTHONHOME=/);assert.doesNotMatch(command,/sh -c/);assert.throws(()=>desktopWindowConfig('<mouse/>','x'),/unavailable/);});
test('late native saves can show a panel without opening a picker; clipboard remains gesture scoped',()=>{const context={focused:true,hidden:false,activeUntil:1000,now:20000};assert.equal(mayClaimFileRequest({operation:'save'},context),true);assert.equal(mayClaimFileRequest({operation:'copy'},context),false);assert.equal(mayClaimFileRequest({operation:'save'},{...context,hidden:true}),false);assert.equal(mayClaimFileRequest({operation:'save'},{...context,focused:false}),false);assert.match(desktopStatus({status:'running',loginStatus:'logged-in',windowVisible:false},true,false),/仍在后台/);});
test('hidden tabs do not exhaust reconnects; returning resumes but intentional leave does not',async()=>{const doc=new EventTarget(),win=new EventTarget();doc.hidden=true;win.navigator={onLine:true};let n=0,seq=0;const jobs=new Map();const r=desktopReconnect({document:doc,window:win,notify(){},reconnect:async()=>n++,schedule:fn=>{jobs.set(++seq,fn);return seq;},cancel:id=>jobs.delete(id)});r.lost();assert.equal(jobs.size,0);doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(jobs.size,1);await [...jobs.values()][0]();assert.equal(n,1);r.connected();doc.dispatchEvent(new Event('visibilitychange'));assert.equal(n,1);r.stop();win.dispatchEvent(new Event('online'));assert.equal(jobs.size,0);});
test('real native close hitbox suppresses both button edges; other clicks and drag-out remain normal',async()=>{let requests=0,probes=0;const input=new WindowCloseInput({probe:async()=>{probes++;return{close:[900,20,44,32]};},request:async()=>requests++,generation:()=>1});const e=(buttons,x=910,y=30,source='one')=>({type:'pointer',source,buttons,x,y});await input.before(e(0));assert.equal(probes,0);await input.before(e(1,100));await input.before(e(0,100));assert.equal(requests,0);await assert.rejects(input.before(e(1)),{code:'desktop_window_close'});await assert.rejects(input.before(e(0)),{code:'desktop_window_close'});assert.equal(requests,1);await assert.rejects(input.before(e(1)),{code:'desktop_window_close'});await assert.rejects(input.before(e(0,800)),{code:'desktop_window_close'});assert.equal(requests,1);});
test('native metadata from a stopped process, missing accessibility or disconnected source cannot trigger close',async()=>{let generation=1,n=0;const gate=Promise.withResolvers();const input=new WindowCloseInput({probe:()=>gate.promise,request:async()=>n++,generation:()=>generation});const work=input.before({type:'pointer',source:'a',buttons:1,x:5,y:5});generation++;input.reset();gate.resolve({close:[0,0,44,32]});await work;await input.before({type:'pointer',source:'a',buttons:0,x:5,y:5});assert.equal(n,0);input.probe=async()=>null;await input.before({type:'pointer',source:'b',buttons:1,x:5,y:5});await input.before({type:'disconnect',source:'b'});assert.equal(input.sources.has('b'),false);});
