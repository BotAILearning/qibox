import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, kind = 'person') {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.contacts[0].kind = kind;
  let now = 1000000;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.scan();
  if (kind === 'person') await a.setReplyOptions({ contact: bridge.contacts[0].id, enabled: true });
  return { a, bridge, provider, advance: (ms = 20000) => { now += ms; } };
}

test('replies retain both speakers and confirmed AI answers across turns, with each incoming burst identified', async t => {
  const { a, bridge, provider, advance } = await fixture(t);
  const contact = bridge.contacts[0].id, foreign = bridge.contacts[1].id;
  bridge.messages.set(contact, []);
  bridge.push(contact, 'other', '周六还是周日见面？');
  bridge.push(contact, 'self', '周六，地点还没定。');
  bridge.push(foreign, 'other', '另一位联系人的私有内容');
  await a.settings({ enabled: true }); await a.tick();
  const location = bridge.push(contact, 'other', '地点呢？'); await a.tick(); advance();
  provider.next = async () => ({ action: 'send', text: '你想在哪儿见？' }); await a.tick();
  assert.equal(bridge.sent.length, 1);
  const answer = bridge.messages.get(contact).at(-1);
  const first = bridge.push(contact, 'other', '公园吧');
  const second = bridge.push(contact, 'other', '下午三点可以吗？');
  await a.tick(); advance();
  provider.next = async () => ({ action: 'skip' }); await a.tick();
  const { input, system } = provider.calls.at(-1);
  assert.deepEqual(input.messages.map(m => [m.direction, m.text]), bridge.messages.get(contact).filter(m => m.text !== 'GENERATED_PRIVATE_MARKER').map(m => [m.direction, m.text]));
  assert.equal(input.messages.find(m => m.id === answer.id).aiGenerated, true);
  assert.equal(input.messages.find(m => m.id === location.id).direction, 'other');
  assert.deepEqual(input.conversation, { latestIncomingId: second.id, lastSelfId: answer.id, incomingSinceLastSelf: [first.id, second.id], pendingIncomingIds: [first.id, second.id] });
  assert.equal(JSON.stringify(input).includes('另一位联系人的私有内容'), false);
  assert.match(system, /先结合前文识别话题/);
  assert.match(system, /不重复询问已经说明的信息/);
});

test('late incoming context cancels the old draft and is included on regeneration', async t => {
  const { a, bridge, provider, advance } = await fixture(t);
  const contact = bridge.contacts[0].id;
  await a.settings({ enabled: true }); await a.tick();
  bridge.push(contact, 'other', '周六可以吗？'); await a.tick(); advance();
  let correction;
  provider.next = async () => {
    correction = bridge.push(contact, 'other', '说错了，是周日。');
    return { action: 'send', text: '周六没问题。' };
  };
  await a.tick(); assert.equal(bridge.sent.length, 0);
  advance(); provider.next = async () => ({ action: 'skip' }); await a.tick();
  const { input } = provider.calls.at(-1);
  assert.equal(input.conversation.latestIncomingId, correction.id);
  assert.equal(input.messages.at(-1).text, '说错了，是周日。');
  assert.equal(bridge.sent.some(message => message.text === '周六没问题。'), false, 'a draft generated against the earlier incoming message must not be sent');
});

test('a handled stop or unavailable historical image stays outside the fresh incoming turn', async t => {
  const { a, bridge, provider, advance } = await fixture(t);
  const contact = bridge.contacts[0].id;
  bridge.messages.set(contact, []);
  await a.settings({ enabled: true }); await a.tick();
  const old = bridge.push(contact, 'other', '本轮结束，不需要回复');
  await a.tick(); advance(); provider.next = async () => ({action:'skip'}); await a.tick();
  const picture = Object.assign(bridge.push(contact,'other','[图片]'),{type:'image'});
  await a.tick(); advance(); await a.tick();
  const fresh = bridge.push(contact,'other','现在是 AI 在回复吗？');
  await a.tick(); advance(); provider.next = async () => ({action:'skip'}); await a.tick();
  const {input,system} = provider.calls.at(-1);
  assert.deepEqual(input.conversation.pendingIncomingIds,[fresh.id]);
  assert.ok(input.messages.some(m=>m.id===old.id));
  assert.equal(input.messages.find(m=>m.id===picture.id).unresolved,true);
  assert.match(system,/历史中的.*不能覆盖后来主动发来的新问题/);
});

test('group context keeps distinct senders and mention metadata', async t => {
  const { a, bridge, provider, advance } = await fixture(t, 'group');
  const target = bridge.contacts[0]; target.kind = 'group'; await a.scan();
  const push = (sender, text, self = false) => Object.assign(bridge.push(target.id, 'other', text), {
    sender: key(sender), mentions: { verified: true, self, all: false, others: false },
  });
  await a.setGroupOptions({ contact: target.id, atMe: true });
  await a.settings({ enabled: true }); await a.tick();
  const earlier = push('member-a', '我选周六。');
  const latest = push('member-b', '我选周日，你呢？', true);
  await a.tick(); advance(); provider.next = async () => ({ action: 'skip' }); await a.tick();
  const { input } = provider.calls.at(-1);
  assert.equal(input.kind, 'group');
  assert.equal(input.conversation.latestIncomingId, latest.id);
  assert.equal(input.messages.find(m => m.id === earlier.id).sender, key('member-a'));
  assert.equal(input.messages.find(m => m.id === latest.id).sender, key('member-b'));
  assert.equal(input.messages.at(-1).mentions.self, true);
  assert.deepEqual(input.conversation.pendingIncomingIds, [latest.id]);
});

test('ignored group mentions remain context but are not pending requests or image reads',async t=>{
  const {a,bridge,provider,advance}=await fixture(t,'group');
  const contact=bridge.contacts[0].id;
  await a.setGroupOptions({contact,realtime:true,confirmRealtime:true});
  await a.settings({enabled:true});await a.tick();
  const ignored=Object.assign(bridge.push(contact,'other','@别人 不要回复'),{type:'image',sender:key('member'),mentions:{verified:true,self:false,all:false,others:true}});
  await a.tick();advance();await a.tick();
  let imageReads=0;bridge.readImage=async()=>{imageReads++;return null;};
  const current=Object.assign(bridge.push(contact,'other','新问题'),{sender:key('member'),mentions:{verified:true,self:false,all:false,others:false}});
  await a.tick();advance(60000);provider.next=async()=>({action:'skip'});await a.tick();
  const input=provider.calls.at(-1).input;
  assert.deepEqual(input.conversation.pendingIncomingIds,[current.id]);
  assert.ok(input.messages.some(m=>m.id===ignored.id));
  assert.equal(imageReads,0);
});
