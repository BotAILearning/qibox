import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageLedger, MESSAGE_LEDGER_LIMITS } from '../server/ai-ledger.mjs';

const scope = 'account\0contact';
const other = text => ({ direction: 'other', text });
const self = text => ({ direction: 'self', text });
const system = text => ({ direction: 'system', text });
const ids = messages => messages.map(message => message.id);
const ambiguous = { code: 'ai_ledger_ambiguous' };
const limited = { code: 'ai_ledger_limit' };

test('unchanged observations retain independent temporary IDs and exact text', () => {
  const ledger = new MessageLedger();
  const messages = [other('嗯'), other('嗯'), self('嗯'), system('  时间\n')];
  const initial = ledger.reconcile(scope, messages);
  assert.equal(new Set(ids(initial)).size, messages.length);
  assert.ok(ids(initial).every(id => /^temporary:[0-9a-f-]{36}$/.test(id)));
  assert.deepEqual(initial.map(({ direction, text }) => ({ direction, text })), messages);
  assert.deepEqual(ledger.reconcile(scope, messages), initial);
});

test('unique complete-prefix append and forward viewport slide retain overlapping IDs', () => {
  const ledger = new MessageLedger();
  const first = ledger.reconcile(scope, [other('第一条'), self('第二条')]);
  const appended = ledger.reconcile(scope, [other('第一条'), self('第二条'), other('第三条')]);
  assert.deepEqual(ids(appended).slice(0, 2), ids(first));
  const shifted = ledger.reconcile(scope, [self('第二条'), other('第三条'), other('第四条')]);
  assert.deepEqual(ids(shifted).slice(0, 2), ids(appended).slice(1));
  assert.ok(!ids(appended).includes(shifted[2].id));
});

test('matching text from different speakers remains distinguishable during a slide', () => {
  const ledger = new MessageLedger();
  const first = ledger.reconcile(scope, [other('嗯'), self('嗯')]);
  const next = ledger.reconcile(scope, [self('嗯'), other('嗯')]);
  assert.equal(next[0].id, first[1].id);
  assert.ok(!ids(first).includes(next[1].id));
});

test('repeated acknowledgements with multiple suffix alignments fail without advancing state', () => {
  const ledger = new MessageLedger();
  const messages = [other('开始'), other('嗯'), other('嗯')];
  const first = ledger.reconcile(scope, messages);
  assert.throws(() => ledger.reconcile(scope, [other('嗯'), other('嗯'), other('新消息')]), ambiguous);
  assert.deepEqual(ledger.reconcile(scope, messages), first);
  const unambiguous = ledger.reconcile(scope, [...messages, other('新消息')]);
  assert.deepEqual(ids(unambiguous).slice(0, 3), ids(first));
});

test('a repeated complete prefix is ambiguous when a shorter suffix also matches', () => {
  const ledger = new MessageLedger();
  const messages = [other('嗯'), other('嗯')];
  const first = ledger.reconcile(scope, messages);
  assert.throws(() => ledger.reconcile(scope, [...messages, self('收到')]), ambiguous);
  assert.deepEqual(ledger.reconcile(scope, messages), first);
});

test('truncation, older history, prepending and unrelated windows never mutate the ledger', () => {
  const ledger = new MessageLedger();
  const messages = [other('甲'), self('乙'), other('丙')];
  const first = ledger.reconcile(scope, messages);
  for (const candidate of [
    [], messages.slice(0, 2), messages.slice(1), [messages[1]],
    [system('更早'), ...messages], [other('别的聊天')],
    [messages[1], messages[0]],
  ]) {
    assert.throws(() => ledger.reconcile(scope, candidate), ambiguous);
    assert.deepEqual(ledger.reconcile(scope, messages), first);
  }
  const next = ledger.reconcile(scope, [...messages, self('丁')]);
  assert.deepEqual(ids(next).slice(0, 3), ids(first));
});

test('a truncated prefix with a coincidental suffix match is still rejected', () => {
  const ledger = new MessageLedger();
  const messages = [other('甲'), other('乙'), other('甲')];
  const first = ledger.reconcile(scope, messages);
  assert.throws(() => ledger.reconcile(scope, messages.slice(0, 2)), ambiguous);
  assert.deepEqual(ledger.reconcile(scope, messages), first);
});

test('a repeated old window cannot disguise prepended history as an append', () => {
  const ledger = new MessageLedger();
  const messages = [other('甲'), self('乙')];
  const first = ledger.reconcile(scope, messages);
  assert.throws(() => ledger.reconcile(scope, [...messages, ...messages]), ambiguous);
  assert.deepEqual(ledger.reconcile(scope, messages), first);
});

test('initial empty observations can acquire messages but populated windows cannot disappear', () => {
  const ledger = new MessageLedger();
  assert.deepEqual(ledger.reconcile(scope, []), []);
  assert.deepEqual(ledger.reconcile(scope, []), []);
  const first = ledger.reconcile(scope, [other('初次消息')]);
  assert.throws(() => ledger.reconcile(scope, []), ambiguous);
  assert.deepEqual(ledger.reconcile(scope, [other('初次消息')]), first);
});

test('scope keys isolate accounts and conversations; clear and restart never reuse IDs', () => {
  const ledger = new MessageLedger(), messages = [other('嗯')];
  const a = ledger.reconcile(scope, messages);
  const b = ledger.reconcile('account\0another-contact', messages);
  const c = ledger.reconcile('another-account\0contact', messages);
  assert.equal(new Set([...ids(a), ...ids(b), ...ids(c)]).size, 3);
  ledger.clear(scope);
  const afterClear = ledger.reconcile(scope, messages);
  assert.notEqual(afterClear[0].id, a[0].id);
  assert.deepEqual(ledger.reconcile('account\0another-contact', messages), b);
  ledger.clear();
  assert.notEqual(ledger.reconcile('account\0another-contact', messages)[0].id, b[0].id);
  assert.notEqual(new MessageLedger().reconcile(scope, messages)[0].id, afterClear[0].id);
});

test('input and returned objects cannot mutate stored messages or smuggle IDs', () => {
  const ledger = new MessageLedger(), input = [{ ...other('原文'), id: 'forged-id' }];
  const first = ledger.reconcile(scope, input), originalId = first[0].id;
  assert.notEqual(originalId, 'forged-id');
  input[0].text = '输入已变更';
  first[0].id = 'overwritten'; first[0].text = '返回已变更'; first.push(self('额外'));
  assert.deepEqual(ledger.reconcile(scope, [other('原文')]), [{ ...other('原文'), id: originalId }]);
});

test('invalid observations fail atomically and never expose the message body in errors', () => {
  const ledger = new MessageLedger(), messages = [other('PRIVATE_BODY_MARKER')];
  const first = ledger.reconcile(scope, messages);
  for (const candidate of [null, {}, [null], [{ direction: 'unknown', text: 'PRIVATE_BODY_MARKER' }], [other(123)]]) {
    assert.throws(() => ledger.reconcile(scope, candidate), error => error.code === 'ai_ledger_invalid' && !error.message.includes('PRIVATE_BODY_MARKER'));
    assert.deepEqual(ledger.reconcile(scope, messages), first);
  }
  for (const key of ['', null, 'a'.repeat(MESSAGE_LEDGER_LIMITS.scopeBytes + 1)]) {
    assert.throws(() => ledger.reconcile(key, messages), { code: 'ai_ledger_invalid' });
  }
});

test('the per-scope message and individual text limits leave a valid scope intact', () => {
  const ledger = new MessageLedger(), messages = Array.from({ length: 300 }, (_, i) => other(String(i)));
  const first = ledger.reconcile(scope, messages);
  assert.throws(() => ledger.reconcile(scope, [...messages, other('超限')]), limited);
  assert.throws(() => ledger.reconcile(scope, [other('a'.repeat(MESSAGE_LEDGER_LIMITS.messageCharacters + 1))]), limited);
  assert.deepEqual(ledger.reconcile(scope, messages), first);
});

test('scope capacity rejects rather than evicts and explicit clear releases capacity', () => {
  const ledger = new MessageLedger(), messages = [other('保留')];
  const first = ledger.reconcile('scope-0', messages);
  for (let i = 1; i < 200; i++) ledger.reconcile(`scope-${i}`, messages);
  assert.throws(() => ledger.reconcile('scope-overflow', messages), limited);
  assert.deepEqual(ledger.reconcile('scope-0', messages), first);
  ledger.clear('scope-199');
  assert.equal(ledger.reconcile('scope-overflow', messages).length, 1);
  ledger.clear();
  assert.equal(ledger.reconcile('fresh', messages).length, 1);
});

test('aggregate UTF-8 body budget rejects atomically and clears release its exact bytes', () => {
  const ledger = new MessageLedger();
  const chunk = other('中'.repeat(20000));
  const old = [other('小')], initial = ledger.reconcile(scope, old);
  const large = Array.from({ length: 69 }, () => ({ ...chunk }));
  ledger.reconcile('large', large); // 4,140,000 UTF-8 bytes, below 4 MiB.
  assert.throws(() => ledger.reconcile(scope, [...old, chunk]), limited);
  assert.deepEqual(ledger.reconcile(scope, old), initial);
  ledger.clear('large');
  const next = ledger.reconcile(scope, [...old, chunk]);
  assert.equal(next[0].id, initial[0].id);
  ledger.clear();
  assert.equal(ledger.reconcile('large', large).length, 69);
});

test('a forward slide releases the outgoing body budget before committing the new window', () => {
  const ledger = new MessageLedger(), large = other('中'.repeat(20000)), anchor = self('唯一锚点');
  const first = ledger.reconcile(scope, [large, anchor]);
  ledger.reconcile('filled', Array.from({ length: 68 }, () => ({ ...large })));
  const shifted = ledger.reconcile(scope, [anchor, large]);
  assert.equal(shifted[0].id, first[1].id);
  assert.notEqual(shifted[1].id, first[0].id);
});
