import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const at = text => Date.parse(text + '+08:00');
async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let time = at('2026-09-21T12:00:00');
  const args = { dataRoot: root, bridge, provider, now: () => time };
  const a = new AIAssistant(args); await a.init(); await a.configure(modelConfig); await a.scan();
  const instances = [a];
  t.after(async () => { for (const instance of instances) if (!instance.closed) await instance.close(); await cleanup(root); });
  return { a, args, async restart() { await a.close(); const b = new AIAssistant(args); instances.push(b); await b.init(); await b.scan(); return b; } };
}

test('最近异常：每条带 id，「清空」把异常真正删掉', async t => {
  const { a } = await fixture(t);
  a.event('error', null, null, '模型连接失败');
  a.event('truncated', null, null, '聊天记录过长，本次只处理最近一段');
  a.event('replied', null, 'reply');
  let state = a.publicState();
  assert.deepEqual(state.recentErrors.map(x => x.message), ['聊天记录过长，本次只处理最近一段', '模型连接失败']);
  assert.ok(state.recentErrors.every(x => typeof x.id === 'string' && x.id));
  assert.equal(state.errorsPage.total, 2);
  state = await a.clearActivityErrors();
  assert.deepEqual(state.recentErrors, []);
  assert.equal(state.errorsPage.total, 0);
  // 台账里真的没有了；无关事件不受影响。
  assert.deepEqual(a.data.errorLog, []);
  assert.ok(a.data.events.some(e => e.code === 'replied'));
});

test('最近异常：清空后重启不会复活，之后的新异常照常显示', async t => {
  const { a, restart } = await fixture(t);
  a.event('error', null, null, '第一次失败');
  await a.clearActivityErrors();
  const b = await restart();
  assert.deepEqual(b.publicState().recentErrors, []);
  b.event('error', null, null, '第二次失败');
  const state = b.publicState();
  assert.equal(state.recentErrors.length, 1);
  assert.equal(state.recentErrors[0].message, '第二次失败');
});

test('最近异常：分页保留全部，不受 2000 条事件上限挤压', async t => {
  const { a } = await fixture(t);
  for (let index = 0; index < 25; index++) { a.event('error', null, null, `第 ${index + 1} 次失败`); a.now = () => Date.now(); }
  const state = a.publicState();
  assert.equal(state.recentErrors.length, 20);
  assert.equal(state.errorsPage.total, 25);
  assert.equal(state.errorsPage.hasMore, true);
  assert.equal(state.errorsPage.nextBefore, state.recentErrors.at(-1).id);
  // 翻到下一页：拿到剩下 5 条，且不与第一页重复。
  const next = a.errorRecords({ limit: 20, before: state.errorsPage.nextBefore });
  assert.deepEqual(next.records.map(x => x.message), ['第 5 次失败', '第 4 次失败', '第 3 次失败', '第 2 次失败', '第 1 次失败']);
  assert.equal(next.page.hasMore, false);
  assert.equal(next.page.total, 25);
  // 正常事件把事件流挤满后，异常仍然完整保留。
  for (let index = 0; index < 2100; index++) a.event('replied', null, 'reply');
  assert.equal(a.data.events.length, 2000);
  assert.equal(a.publicState().errorsPage.total, 25);
  assert.throws(() => a.errorRecords({ limit: 20, before: 'not-an-id' }), /游标/);
});

test('最近异常：台账有 10000 条硬上限，异常风暴不会撑爆数据文件', async t => {
  const { a } = await fixture(t);
  for (let index = 0; index < 10005; index++) a.event('error', null, null, `失败 ${index + 1}`);
  assert.equal(a.data.errorLog.length, 10000);
  const state = a.publicState();
  assert.equal(state.errorsPage.total, 10000);
  // 丢的是最早的：最新那条一定还在。
  assert.equal(a.data.errorLog[0].message, '失败 10005');
  assert.ok(!a.data.errorLog.some(e => e.message === '失败 1'));
  // 单条文案也截到 2000 字以内。
  a.event('error', null, null, 'x'.repeat(5000));
  assert.equal(a.publicState().recentErrors[0].message.length, 2000);
});

test('最近异常：老数据里的异常迁入台账，已清空过的不复活', async t => {
  const { a, args } = await fixture(t);
  a.event('error', null, null, 'A');
  a.event('error', null, null, 'B');
  await a.save(); await a.close();
  const file = path.join(args.dataRoot, 'ai-assistant.json');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  delete raw.errorLog;
  raw.dismissedErrors = [raw.events.find(e => e.detail === 'A').id];
  await writeFile(file, JSON.stringify(raw));
  const b = new AIAssistant(args); await b.init();
  try {
    assert.deepEqual(b.publicState().recentErrors.map(x => x.message), ['B']);
    assert.equal(b.data.dismissedErrors, undefined);
  } finally { await b.close(); }
});
