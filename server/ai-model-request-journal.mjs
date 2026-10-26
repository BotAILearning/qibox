import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile,stat,rm,open} from 'node:fs/promises';
import {atomicJson,AppError} from './files.mjs';

const states=new WeakMap();
function state(a){if(!states.has(a))states.set(a,{pending:new Map(),queues:new Map()});return states.get(a);}
const file=(a,id)=>{if(!/^[a-f0-9]{64}$/.test(id))throw new AppError('模型请求对象标识无效');return path.join(path.dirname(a.file),'ai-model-requests',id+'.json');};
const settled=(p,v)=>p?.closedModelRequestId===v.id&&(
 ['explicit-retry','new-incoming','not-dispatched','known-error'].includes(p.closedModelRequestReason)||
 p.handledIncomingId===v.incomingId||p.preparedReply?.latestIncomingId===v.incomingId||p.replyCursor?.pending===false||
 v.context&&p.groupContextWait?.context===v.context);
function serial(a,id,task){const s=state(a),p=(s.queues.get(id)||Promise.resolve()).then(task);s.queues.set(id,p.catch(()=>{}));return p;}
async function durable(name){const h=await open(name,'r+');try{await h.sync();}finally{await h.close();}if(process.platform==='linux'){const d=await open(path.dirname(name),'r');try{await d.sync();}finally{await d.close();}}}
async function load(a,p){
 const s=state(a);if(s.pending.has(p.id))return s.pending.get(p.id);
 let value;try{const name=file(a,p.id);if((await stat(name)).size>4096)throw Error('large journal');value=JSON.parse(await readFile(name,'utf8'));
  if(value.format!==1||!/^[a-f0-9-]{36}$/.test(value.id)||value.account!==p.account||value.contact!==p.contact||typeof value.incomingId!=='string'||!value.incomingId||value.incomingId.length>256||!Number.isFinite(value.at))throw Error('invalid journal');
 }catch(error){if(error.code==='ENOENT')value=null;else value={account:p.account,contact:p.contact,state:'unreadable',incomingId:null};}
 s.pending.set(p.id,value);return value;
}
export async function restoreModelRequest(a,p){
 return serial(a,p.id,async()=>{const s=state(a),v=await load(a,p);if(!v)return;
  if(v.id&&settled(p,v)){await rm(file(a,p.id),{force:true});s.pending.set(p.id,null);if(p.modelRequestUnknown?.id===v.id)delete p.modelRequestUnknown;return;}
  p.modelRequestUnknown={...v};
 });
}
export async function startModelRequest(a,p,incoming,context){
 return serial(a,p.id,async()=>{const s=state(a),old=await load(a,p);
  if(old&&(old.state==='unreadable'||old.id!==p.closedModelRequestId))throw new AppError('旧模型请求结果仍未知，请先核对后明确重新请求',409,'ai_model_result_unknown');
  const intent={format:1,id:randomUUID(),account:p.account,contact:p.contact,incomingId:incoming.id,context,at:a.now(),state:'requesting'};
  // A small per-object journal must not wait on unrelated configuration saves.
  // No chat body/key is stored and no request is dispatched until this commits.
  await atomicJson(file(a,p.id),intent);await durable(file(a,p.id));s.pending.set(p.id,intent);p.modelRequestUnknown=intent;return intent;
 });
}
export function closeModelRequest(p,reason='response-known'){
 if(p.modelRequestUnknown?.state==='unreadable')throw new AppError('模型请求记录不可读取，已保留原文件；请先恢复记录，再重新请求',409,'ai_request_journal_corrupt');
 if(p.modelRequestUnknown?.id){p.closedModelRequestId=p.modelRequestUnknown.id;p.closedModelRequestReason=reason;}
 delete p.modelRequestUnknown;
}
export async function cleanClosedModelRequests(a,snapshot){
 const s=state(a);
 const closing=[...s.pending].filter(([id,v])=>v?.id&&settled(snapshot.profiles?.[id],v));
 // Commit the result/handled cursor before removing its dispatch intent.
 if(closing.length)await durable(a.file);
 await Promise.all(closing.map(([id,v])=>serial(a,id,async()=>{
  const current=s.pending.get(id);if(current?.id!==v.id)return;
  await rm(file(a,id),{force:true});s.pending.set(id,null);
 })));
}
