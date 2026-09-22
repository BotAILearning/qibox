import { createHash } from 'node:crypto';
import { defaultStyle } from '../server/ai-schema.mjs';

export const key = text => createHash('sha256').update(text).digest('hex');
export const modelConfig = { baseUrl: 'https://models.example.test/v1', model: 'test-model', apiKey: 'only-a-test-key', timeout: 30, consent: true };
export const strategy = { purpose: '邀请参加活动', content: '询问是否有兴趣', persona: '自然简短', replyGoal: '解答活动问题', facts: '活动尚未确定时间', boundaries: '不擅自承诺时间和价格', maxRounds: 3 };
export class AIModelFixture {
  constructor() { this.calls = []; this.next = null; }
  async test() {}
  async models() { return ['fixture-chat', 'fixture-chat-pro']; }
  async complete(config, system, input, signal) {
    this.calls.push({ system, input });
    if (this.next) { const task = this.next; this.next = null; return task(input, signal); }
    if (input.conversations) return { profiles: input.conversations.map(({ contact }) => ({ contact, style: { ...defaultStyle, category: 'friends', roles: ['普通朋友'] } })) };
    if (input.material !== undefined) return { style: { ...defaultStyle, category: 'friends', roles: ['普通朋友'] }, ignoredRaw: 'CHAT_PRIVATE_MARKER' };
    return { action: 'send', text: 'GENERATED_PRIVATE_MARKER', ...(input.updateStyle ? { style: { ...defaultStyle, warmth: '亲切' } } : {}) };
  }
}
export class ChatFixture {
  constructor() {
    this.account = key('account-one'); this.contacts = ['甲', '乙', '丙'].map(label => ({ id: key(label), label: `测试对象${label}`, kind: 'person' }));
    this.messages = new Map(this.contacts.map(c => [c.id, [{ id: key(`initial-${c.id}`), direction: 'self', text: 'CHAT_PRIVATE_MARKER' }]]));
    this.sent = []; this.sequence = 0; this.delivery = null;
  }
  async scan() { return { available: true, account: this.account, contacts: this.contacts }; }
  async read({ contact }) { const messages = structuredClone(this.messages.get(contact)); return { account: this.account, contact, messages, revision: key(JSON.stringify(messages)) }; }
  push(contact, direction, text = 'CHAT_NEW_MARKER') { const message = { id: key(String(++this.sequence)), direction, text }; this.messages.get(contact).push(message); return message; }
  async send(request) {
    request.signal?.throwIfAborted();
    if (this.delivery) return this.delivery(request);
    const before = await this.read(request);
    if (before.account !== request.account || before.revision !== request.revision) return { status: 'stale' };
    this.sent.push({ contact: request.contact, text: request.text });
    const message = this.push(request.contact, 'self', request.text), after = await this.read(request);
    return { status: 'sent', messageId: message.id, revision: after.revision };
  }
}
